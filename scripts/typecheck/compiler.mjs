// Lower compiler priority before loading its CLI on every host.
import { constants, setPriority } from 'node:os'
import { pathToFileURL } from 'node:url'

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL)
process.argv.splice(1, 1)
await import(pathToFileURL(process.argv[1]).href)
