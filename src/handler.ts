// handler.ts

import {
  SSMClient,
  SendCommandCommand
} from '@aws-sdk/client-ssm'

type Event = {
  body: string
}

const client =
  new SSMClient({})


export async function handler(
  event: Event
) {

  console.log(
    'Received event:',
    JSON.stringify(event)
  )


  const body =
    JSON.parse(
      event.body
    )


  console.log(
    'Parsed body:',
    JSON.stringify(body)
  )


  const {
    instanceId,
    volumeId
  } =
    body


  //
  // Validate instance ID
  //

  if (
    !instanceId
  ) {

    return {
      statusCode: 400,

      body:
        JSON.stringify({
          error:
            'instanceId is required'
        })
    }

  }


  //
  // Validate volume ID
  //

  if (
    !volumeId
  ) {

    return {
      statusCode: 400,

      body:
        JSON.stringify({
          error:
            'volumeId is required'
        })
    }

  }


  //
  // Run filesystem expansion
  //

  const command =
    new SendCommandCommand({

      DocumentName:
        'AWS-RunShellScript',

      InstanceIds: [
        instanceId
      ],

      Parameters: {

        commands: [

          //
          // Remove the hyphen from the EBS volume ID
          // because NVMe serial numbers omit it.
          //

          //`VOLUME_ID=${volumeId.replace('-', '')}`,
          `VOLUME_ID=${volumeId.replace('vol-', 'vol')}`,

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

          '  echo "Looking for serial: $VOLUME_ID"',

          '  echo "Available devices:"',

          '  lsblk -ndo NAME,SERIAL',

          '  exit 1',

          'fi',

          //
          // Add /dev prefix.
          //

          'DEVICE="/dev/$DEVICE"',

          'echo "EBS volume: ' + volumeId + '"',

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

  // const command =
  //   new SendCommandCommand({

  //     DocumentName:
  //       'AWS-RunShellScript',

  //     InstanceIds: [
  //       instanceId
  //     ],

  //     Parameters: {

  //       commands: [

  //         //
  //         // Store the EBS volume ID
  //         //

  //         `VOLUME_ID='${volumeId}'`,

  //         //
  //         // Find the Linux device associated
  //         // with the EBS volume.
  //         //

  //         'DEVICE=$(lsblk -ndo NAME,SERIAL | grep "$VOLUME_ID" | cut -d " " -f 1 | head -n 1)',

  //         //
  //         // Check that the device was found.
  //         //

  //         'if [ -z "$DEVICE" ]; then',

  //         '  echo "ERROR: Could not find device for EBS volume $VOLUME_ID"',

  //         '  exit 1',

  //         'fi',

  //         //
  //         // Display the volume and device.
  //         //

  //         'echo "EBS volume: $VOLUME_ID"',

  //         'echo "Device: $DEVICE"',

  //         //
  //         // Display current disk information.
  //         //

  //         'echo "Current disk information:"',

  //         'lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT "$DEVICE"',

  //         //
  //         // Find the first partition.
  //         //

  //         'PARTITION=$(lsblk -lnpo NAME,TYPE "$DEVICE" | grep " part$" | cut -d " " -f 1 | head -n 1)',

  //         //
  //         // If a partition exists,
  //         // expand the partition.
  //         //

  //         'if [ -n "$PARTITION" ]; then',

  //         '  echo "Partition: $PARTITION"',

  //         '  PARTITION_NUMBER=$(echo "$PARTITION" | grep -o "[0-9]*$")',

  //         '  growpart "$DEVICE" "$PARTITION_NUMBER"',

  //         'else',

  //         '  echo "No partition found. Using device directly."',

  //         '  PARTITION="$DEVICE"',

  //         'fi',

  //         //
  //         // Detect filesystem type.
  //         //

  //         'FILESYSTEM=$(blkid -o value -s TYPE "$PARTITION")',

  //         'echo "Filesystem: $FILESYSTEM"',

  //         //
  //         // Expand ext4 filesystem.
  //         //

  //         'if [ "$FILESYSTEM" = "ext4" ]; then',

  //         '  echo "Expanding ext4 filesystem"',

  //         '  resize2fs "$PARTITION"',

  //         //
  //         // Expand XFS filesystem.
  //         //

  //         'elif [ "$FILESYSTEM" = "xfs" ]; then',

  //         '  MOUNTPOINT=$(findmnt -n -o TARGET "$PARTITION")',

  //         '  if [ -z "$MOUNTPOINT" ]; then',

  //         '    echo "ERROR: XFS filesystem is not mounted"',

  //         '    exit 1',

  //         '  fi',

  //         '  echo "Expanding XFS filesystem mounted at $MOUNTPOINT"',

  //         '  xfs_growfs "$MOUNTPOINT"',

  //         //
  //         // Unsupported filesystem.
  //         //

  //         'else',

  //         '  echo "ERROR: Unsupported filesystem: $FILESYSTEM"',

  //         '  exit 1',

  //         'fi',

  //         //
  //         // Display final disk information.
  //         //

  //         'echo "Final filesystem state:"',

  //         'lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT "$DEVICE"',

  //         'echo "Filesystem usage:"',

  //         'df -Th'

  //       ]

  //     }

  //   })


  try {

    console.log(
      'Sending SSM command for:',
      JSON.stringify({
        instanceId,
        volumeId
      })
    )


    const result =
      await client.send(
        command
      )


    return {

      statusCode: 200,

      body:
        JSON.stringify({

          commandId:
            result.Command?.CommandId,

          instanceId,

          volumeId,

          status:
            result.Command?.Status

        })

    }

  } catch (
    error
  ) {

    console.error(
      'Failed to send SSM command',
      error
    )


    return {

      statusCode: 500,

      body:
        JSON.stringify({

          error:
            'Failed to send filesystem expansion command'

        })

    }

  }

}

// import {
//   SSMClient,
//   SendCommandCommand
// } from '@aws-sdk/client-ssm'

// type Event = {
//   body: string
// }

// const client = new SSMClient({})

// export async function handler(event: Event) {

//   console.log(
//     'Received event:',
//     JSON.stringify(event)
//   )

//   const body =
//     JSON.parse(
//       event.body
//     )

//   console.log(
//     'Parsed body:',
//     JSON.stringify(body)
//   )

//   const {
//     instanceId,
//     volumeId
//   } = body


//   //
//   // Validate instance ID
//   //

//   if (
//     !instanceId
//   ) {
//     return {
//       statusCode: 400,
//       body: JSON.stringify({
//         error:
//           'instanceId is required'
//       })
//     }
//   }


//   //
//   // Validate volume ID
//   //

//   if (
//     !volumeId
//   ) {
//     return {
//       statusCode: 400,
//       body: JSON.stringify({
//         error:
//           'volumeId is required'
//       })
//     }
//   }


//   //
//   // Run filesystem expansion
//   //

//   const command =
//     new SendCommandCommand({

//       DocumentName:
//         'AWS-RunShellScript',

//       InstanceIds: [
//         instanceId
//       ],

//       Parameters: {

//         commands: [

//           //
//           // Find the device associated
//           // with the EBS volume.
//           //

//           `VOLUME_ID="${volumeId}"`,

//           `DEVICE=$(lsblk -ndo NAME,SERIAL | awk -v id="$VOLUME_ID" '$2 ~ id {print "/dev/" $1; exit}')`,

//           `if [ -z "$DEVICE" ]; then echo "ERROR: Could not find device for EBS volume $VOLUME_ID"; exit 1; fi`,

//           `echo "EBS volume: $VOLUME_ID"`,

//           `echo "Device: $DEVICE"`,

//           //
//           // Display current disk information.
//           //

//           'lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT "$DEVICE"',

//           //
//           // Find the first partition.
//           //

//           `PARTITION=$(lsblk -lnpo NAME,TYPE "$DEVICE" | awk '$2 == "part" {print $1; exit}')`,

//           //
//           // If there is a partition, expand it.
//           //

//           `if [ -n "$PARTITION" ]; then`,

//           `  echo "Partition: $PARTITION"`,

//           `  PARTITION_NUMBER=$(echo "$PARTITION" | grep -o '[0-9]*$')`,

//           `  growpart "$DEVICE" "$PARTITION_NUMBER"`,

//           `else`,

//           `  echo "No partition found. Using device directly."`,

//           `  PARTITION="$DEVICE"`,

//           `fi`,

//           //
//           // Detect filesystem type.
//           //

//           `FILESYSTEM=$(blkid -o value -s TYPE "$PARTITION")`,

//           `echo "Filesystem: $FILESYSTEM"`,

//           //
//           // Expand ext4 filesystem.
//           //

//           `if [ "$FILESYSTEM" = "ext4" ]; then`,

//           `  echo "Expanding ext4 filesystem"`,

//           `  resize2fs "$PARTITION"`,

//           //
//           // Expand XFS filesystem.
//           //

//           `elif [ "$FILESYSTEM" = "xfs" ]; then`,

//           `  MOUNTPOINT=$(findmnt -n -o TARGET "$PARTITION")`,

//           `  if [ -z "$MOUNTPOINT" ]; then`,

//           `    echo "ERROR: XFS filesystem is not mounted"`,

//           `    exit 1`,

//           `  fi`,

//           `  echo "Expanding XFS filesystem mounted at $MOUNTPOINT"`,

//           `  xfs_growfs "$MOUNTPOINT"`,

//           `else`,

//           `  echo "ERROR: Unsupported filesystem: $FILESYSTEM"`,

//           `  exit 1`,

//           `fi`,

//           //
//           // Display final disk information.
//           //

//           `echo "Final filesystem state:"`,

//           `lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT "$DEVICE"`,

//           `df -Th`

//         ]

//       }

//     })


//   try {

//     console.log(
//       'Sending SSM command for:',
//       JSON.stringify({
//         instanceId,
//         volumeId
//       })
//     )

//     const result =
//       await client.send(
//         command
//       )


//     return {
//       statusCode: 200,
//       body: JSON.stringify({
//         commandId:
//           result.Command?.CommandId,
//         instanceId,
//         volumeId,
//         status:
//           result.Command?.Status
//       })
//     }

//   } catch (
//   error
//   ) {

//     console.error(
//       'Failed to send SSM command',
//       error
//     )

//     return {
//       statusCode: 500,
//       body: JSON.stringify({
//         error:
//           'Failed to send filesystem expansion command'
//       })
//     }

//   }

// }