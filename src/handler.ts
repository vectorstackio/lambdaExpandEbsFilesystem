// handler.ts

import { SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm'

type Event = {
  body: string
}

const client = new SSMClient({})

export async function handler(event: Event) {
  // Never log request data or parser errors: they can contain credentials.
  let body
  try {
    body = JSON.parse(event.body)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Invalid body')
    }
  } catch {
    console.error('Filesystem expansion request rejected: invalid JSON object')
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Request body must be a JSON object' })
    }
  }

  const { instanceId, volumeId } = body

  //
  // Validate instance ID
  //
  if (typeof instanceId !== 'string' ||
      ![10, 19].includes(instanceId.length) ||
      !/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(instanceId)) {
    return {
      statusCode: 400,
      body: JSON.stringify({error: 'instanceId must be a canonical EC2 instance ID'})
    }
  }

  //
  // Validate volume ID
  //
  if (typeof volumeId !== 'string' ||
      ![12, 21].includes(volumeId.length) ||
      !/^vol-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(volumeId)) {
    return {
      statusCode: 400,
      body: JSON.stringify({error: 'volumeId must be a canonical EBS volume ID'})
    }
  }

  //
  // Run filesystem expansion
  //
  const command = new SendCommandCommand({
    DocumentName: 'AWS-RunShellScript',
    InstanceIds: [instanceId],
    Parameters: {
      commands: [
        //
        // Remove the hyphen from the EBS volume ID
        // because NVMe serial numbers omit it.
        //
        `VOLUME_ID='${volumeId.replace('vol-', 'vol')}'`,

        //
        // Find the NVMe device associated
        // with the EBS volume.
        //
        'DEVICE=$(lsblk -ndo NAME,SERIAL | grep "$VOLUME_ID" | cut -d " " -f 1 | head -n 1)',

        //
        // Make sure the device was found.
        //
        'if [ -z "$DEVICE" ]; then',
        '  echo "ERROR: Could not find device for EBS volume"',
        '  echo "Available devices:"',
        '  lsblk -ndo NAME,SERIAL',
        '  exit 1',
        'fi',

        //
        // Add /dev prefix.
        //
        'DEVICE="/dev/$DEVICE"',


        'echo "NVMe device: $DEVICE"',

        //
        // Display current disk information.
        //
        'echo "Current disk information:"',
        'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT "$DEVICE"',

        //
        // Find the first partition.
        //
        'PARTITION=$(lsblk -lnpo NAME,TYPE "$DEVICE" | grep " part$" | cut -d " " -f 1 | head -n 1)',

        //
        // Expand the partition if one exists.
        //
        'if [ -n "$PARTITION" ]; then',
        '  echo "Partition: $PARTITION"',
        '  PARTITION_NUMBER=$(echo "$PARTITION" | grep -o "[0-9]*$")',
        '  echo "Partition number: $PARTITION_NUMBER"',
        '  growpart "$DEVICE" "$PARTITION_NUMBER"',
        'else',
        '  echo "No partition found. Using device directly."',
        '  PARTITION="$DEVICE"',
        'fi',
        //
        // Detect filesystem.
        //
        'FILESYSTEM=$(blkid -o value -s TYPE "$PARTITION")',
        'echo "Filesystem: $FILESYSTEM"',
        //
        // Expand ext4.
        //
        'if [ "$FILESYSTEM" = "ext4" ]; then',
        '  echo "Expanding ext4 filesystem"',
        '  resize2fs "$PARTITION"',
        //
        // Expand XFS.
        //
        'elif [ "$FILESYSTEM" = "xfs" ]; then',

        '  MOUNTPOINT=$(findmnt -n -o TARGET "$PARTITION")',

        '  if [ -z "$MOUNTPOINT" ]; then',

        '    echo "ERROR: XFS filesystem is not mounted"',

        '    exit 1',

        '  fi',
        '  echo "Expanding XFS filesystem at $MOUNTPOINT"',
        '  xfs_growfs "$MOUNTPOINT"',
        //
        // Unsupported filesystem.
        //
        'else',
        '  echo "ERROR: Unsupported filesystem: $FILESYSTEM"',
        '  exit 1',
        'fi',
        //
        // Display final state.
        //
        'echo "Final filesystem state:"',
        'lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT "$DEVICE"',
        'echo "Filesystem usage:"',
        'df -Th'
      ]
    }
  })

  try {
    console.log('Sending filesystem expansion SSM command')

    const result = await client.send(command)

    return {
      statusCode: 200,
      body: JSON.stringify({
        commandId: result.Command?.CommandId,
        instanceId,
        volumeId,
        status: result.Command?.Status
      })
    }

  } catch {
    console.error('Failed to send SSM command')

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error in expandEbsFilesystemLambda' })
    }
  }
}