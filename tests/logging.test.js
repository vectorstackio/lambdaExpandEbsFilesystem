import { test, vi, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send(command) { return sendMock(command) } },
  SendCommandCommand: class { constructor(input) { this.input = input } }
}))

import { handler } from '../src/handler.ts'

const source = fs.readFileSync(new URL('../src/handler.ts', import.meta.url), 'utf8')
const marker = 'SENSITIVE_TEST_VALUE_DO_NOT_LOG'
const allowed = new Set([
  'Filesystem expansion request rejected: invalid JSON object',
  'Sending filesystem expansion SSM command', 'Failed to send SSM command'
])

function fixture(send) {
  const logs = []
  const requests = []
  for (const level of ['log', 'error', 'warn', 'info', 'debug', 'trace', 'dir', 'table']) {
    vi.spyOn(console, level).mockImplementation((...args) => logs.push(args))
  }
  sendMock.mockImplementation(async command => {
    requests.push(command.input)
    return send(command.input)
  })
  return { handler, logs, requests }
}
afterEach(() => {
  vi.restoreAllMocks()
  sendMock.mockReset()
})
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
  const result = { Command: { CommandId: 'test-command', Status: 'Pending', ignored: marker } }
  const f = fixture(async () => result)
  const response = await f.handler(event(valid))
  assert.equal(response.statusCode, 200)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(JSON.parse(response.body), { commandId: 'test-command', instanceId: valid.instanceId, volumeId: valid.volumeId, status: 'Pending' })
  assert.equal(f.requests[0].DocumentName, 'AWS-RunShellScript')
  assert.equal(f.requests[0].InstanceIds[0], valid.instanceId)
  const outputs = f.requests[0].Parameters.commands.filter(line => /^\s*echo\b/.test(line))
  assert.ok(outputs.every(line => !line.includes(valid.volumeId) && !line.includes('$VOLUME_ID')))
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
  const cases = [{ volumeId: marker, secret: marker }, { instanceId: marker, secret: marker }]
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

test('missing and non-object bodies return the documented error without calling SSM', async () => {
  for (const body of [undefined, '', 'null', '[]', '42', 'true', '"text"', '{']) {
    const f = fixture(() => { throw new Error('Unexpected AWS call') })
    const response = await f.handler({ body })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(JSON.parse(response.body), { error: 'Request body must be a JSON object' })
    assert.equal(f.requests.length, 0)
  }
})

test('invalid identifiers produce specific errors and instance validation takes precedence', async () => {
  for (const [body, error] of [
    [{}, 'instanceId must be a canonical EC2 instance ID'],
    [{ instanceId: valid.instanceId }, 'volumeId must be a canonical EBS volume ID'],
    [{ instanceId: 'i-0123456g', volumeId: valid.volumeId }, 'instanceId must be a canonical EC2 instance ID'],
    [{ instanceId: valid.instanceId, volumeId: 'vol-0123456g' }, 'volumeId must be a canonical EBS volume ID']
  ]) {
    const f = fixture(() => { throw new Error('Unexpected AWS call') })
    const response = await f.handler(event(body))
    assert.equal(response.statusCode, 400)
    assert.deepEqual(JSON.parse(response.body), { error })
    assert.equal(f.requests.length, 0)
  }
})

test('partial SSM responses omit unavailable command fields', async () => {
  for (const result of [{}, { Command: {} }, { Command: { CommandId: 'cmd' } }, { Command: { Status: 'Pending' } }]) {
    const f = fixture(async () => result)
    const response = await f.handler(event(valid))
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.body), {
      ...('CommandId' in (result.Command || {}) ? { commandId: result.Command.CommandId } : {}),
      instanceId: valid.instanceId,
      volumeId: valid.volumeId,
      ...('Status' in (result.Command || {}) ? { status: result.Command.Status } : {})
    })
  }
})

test('SSM command targets the instance and contains the filesystem expansion steps', async () => {
  const f = fixture(async () => ({ Command: { CommandId: 'cmd', Status: 'Pending' } }))
  await f.handler(event(valid))
  assert.equal(f.requests.length, 1)
  const input = f.requests[0]
  assert.equal(input.DocumentName, 'AWS-RunShellScript')
  assert.equal(input.InstanceIds.length, 1)
  assert.equal(input.InstanceIds[0], valid.instanceId)
  const script = input.Parameters.commands.join('\n')
  for (const step of ['lsblk -ndo NAME,SERIAL', 'if [ -z "$DEVICE" ]', 'growpart "$DEVICE" "$PARTITION_NUMBER"', 'resize2fs "$PARTITION"', 'findmnt -n -o TARGET "$PARTITION"', 'xfs_growfs "$MOUNTPOINT"', 'Unsupported filesystem', 'df -Th']) {
    assert.ok(script.includes(step), `Missing command step: ${step}`)
  }
})

test('SSM rejection returns a generic error and no sensitive service details', async () => {
  const f = fixture(async () => { throw new Error(marker) })
  const response = await f.handler(event(valid))
  assert.equal(response.statusCode, 500)
  assert.deepEqual(JSON.parse(response.body), { error: 'Internal Server Error in expandEbsFilesystemLambda' })
  assert.equal(f.requests.length, 1)
  checkLogs(f.logs)
})
