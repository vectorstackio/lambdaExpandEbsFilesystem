const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const operation = path.basename(path.resolve(__dirname, '..'))
const resize = operation === 'resizeEBSVolume'
const source = fs.readFileSync(path.resolve(__dirname, '../src/handler.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const marker = 'SENSITIVE_TEST_VALUE_DO_NOT_LOG'
const allowed = new Set(resize ? [
  'Resize request rejected: invalid JSON object',
  'Validation failed: volumeId is missing', 'Validation failed: size is missing',
  'Validation failed: invalid size', 'Calling ModifyVolume',
  'ModifyVolume succeeded', 'ModifyVolume failed'
] : [
  'Filesystem expansion request rejected: invalid JSON object',
  'Sending filesystem expansion SSM command', 'Failed to send SSM command'
])
function fixture(send) {
  const logs = []
  const requests = []
  const logger = Object.fromEntries(['log', 'error', 'warn', 'info', 'debug', 'trace', 'dir', 'table'].map(level => [level, (...args) => logs.push(args)]))
  class Client {
    async send(command) { requests.push(command.input); return send(command.input) }
  }
  class Command { constructor(input) { this.input = input } }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console: logger,
    require(name) {
      assert.ok(['@aws-sdk/client-ec2', '@aws-sdk/client-ssm'].includes(name))
      return { EC2Client: Client, SSMClient: Client, ModifyVolumeCommand: Command, SendCommandCommand: Command }
    }
  })
  return { handler: module.exports.handler, logs, requests }
}
function checkLogs(logs) {
  for (const args of logs) {
    assert.equal(args.length, 1)
    assert.equal(typeof args[0], 'string')
    assert.ok(allowed.has(args[0]))
    assert.ok(!args[0].includes(marker))
  }
}
function event(body) {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { authorization: marker, cookie: marker, 'x-amz-security-token': marker },
    requestContext: { authorizer: { credentials: marker } },
    extra: marker
  }
}
const valid = { volumeId: 'vol-0123456789abcdef0', instanceId: 'i-0123456789abcdef0', size: 32, credentials: marker, nested: { token: marker } }

test('success logs only allowlisted messages; request and service data never reach logs', async () => {
  const result = resize ? { VolumeModification: { VolumeId: 'vol-0123456789abcdef0', OriginalSize: 16, TargetSize: 32, ModificationState: 'modifying', ignored: marker } } : { Command: { CommandId: 'test-command', Status: 'Pending', ignored: marker } }
  const f = fixture(async () => result)
  const response = await f.handler(event(valid))
  assert.equal(response.statusCode, 200)
  assert.equal(f.requests.length, 1)
  if (resize) assert.deepEqual(JSON.parse(response.body), { volumeId: valid.volumeId, originalSize: 16, targetSize: 32, state: 'modifying' })
  else {
    assert.deepEqual(JSON.parse(response.body), { commandId: 'test-command', instanceId: valid.instanceId, volumeId: valid.volumeId, status: 'Pending' })
    assert.equal(f.requests[0].DocumentName, 'AWS-RunShellScript')
    assert.equal(f.requests[0].InstanceIds[0], valid.instanceId)
    const outputs = f.requests[0].Parameters.commands.filter(line => /^\s*echo\b/.test(line))
    assert.ok(outputs.every(line => !line.includes(valid.volumeId) && !line.includes('$VOLUME_ID')))
  }
  assert.ok(f.logs.length > 0)
  checkLogs(f.logs)
})

test('SDK errors with sensitive messages, metadata, headers and throwing getters are not logged or serialized', async () => {
  for (const error of [Object.assign(new Error(marker), { authorization: marker, $metadata: { headers: { authorization: marker } } }), new Proxy({}, { get() { throw new Error(marker) } })]) {
    const f = fixture(async () => { throw error })
    const response = await f.handler(event(valid))
    assert.equal(response.statusCode, 500)
    assert.ok(!response.body.includes(marker))
    checkLogs(f.logs)
  }
})

test('malformed JSON cannot leak through parser exceptions or reach AWS', async () => {
  for (const body of ['{"secret":"' + marker + '", invalid}', 'null', '[]', '"' + marker + '"']) {
    const f = fixture(async () => { throw new Error('Unexpected AWS call') })
    const response = await f.handler(event(body))
    assert.equal(response.statusCode, 400)
    assert.ok(!response.body.includes(marker))
    assert.equal(f.requests.length, 0)
    checkLogs(f.logs)
  }
})

test('validation paths never log arbitrary request fields', async () => {
  const cases = resize ? [
    { size: 32, secret: marker }, { volumeId: marker },
    { volumeId: marker, size: marker }, { volumeId: marker, size: { secret: marker } },
    { volumeId: marker, size: -1 }
  ] : [{ volumeId: marker, secret: marker }, { instanceId: marker, secret: marker }]
  for (const body of cases) {
    const f = fixture(async () => { throw new Error('Unexpected AWS call') })
    const response = await f.handler(event(body))
    assert.equal(response.statusCode, 400)
    assert.equal(f.requests.length, 0)
    checkLogs(f.logs)
  }
})

test('every direct console call has exactly one allowlisted literal argument, including multiline statements', () => {
  const ast = ts.createSourceFile('handler.ts', source, ts.ScriptTarget.Latest, true)
  assert.equal(ast.parseDiagnostics.length, 0)
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === 'console') {
      assert.equal(node.arguments.length, 1)
      assert.ok(ts.isStringLiteral(node.arguments[0]))
      assert.ok(allowed.has(node.arguments[0].text))
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
})


test('canonical ID validation blocks shell injection and unexpected types before SSM', async () => {
  const suffixes = ['; echo PWNED', '$(id)', String.fromCharCode(96) + 'id' + String.fromCharCode(96), '\n', '\r\n', ' ', "'", '"', '| id', '&& id', '/../../x', '\u0000', '\u2028']
  for (const [name, prefix] of [['instanceId', 'i-'], ['volumeId', 'vol-']]) {
    const invalid = [undefined, null, false, true, 123, {}, [], ['id'], '', prefix, prefix + 'abcdefg0', prefix + 'ABCDEF01', prefix + '123456789', prefix + '1234567890123456', prefix + '123456789012345678', ' ' + prefix + '01234567', ...suffixes.map(s => prefix + '01234567' + s)]
    for (const value of invalid) {
      const f = fixture(async () => { throw new Error('Unexpected AWS call') })
      const response = await f.handler(event({ ...valid, [name]: value }))
      assert.equal(response.statusCode, 400)
      assert.equal(f.requests.length, 0)
      assert.ok(!response.body.includes(marker))
      checkLogs(f.logs)
    }
  }
})

test('legacy and current canonical IDs retain response shape and only a quoted hex serial enters the script', async () => {
  for (const digits of ['01234567', '0123456789abcdef0']) {
    const f = fixture(async () => ({ Command: { CommandId: 'command', Status: 'Pending' } }))
    const input = { instanceId: 'i-' + digits, volumeId: 'vol-' + digits }
    const response = await f.handler(event(input))
    assert.equal(response.statusCode, 200)
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].InstanceIds[0], input.instanceId)
    assert.equal(f.requests[0].Parameters.commands[0], "VOLUME_ID='vol" + digits + "'")
    assert.deepEqual(JSON.parse(response.body), { ...input, commandId: 'command', status: 'Pending' })
    checkLogs(f.logs)
  }
})
