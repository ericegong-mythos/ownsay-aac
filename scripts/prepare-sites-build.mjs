import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// Build output is entirely generated. Clear only this project's explicit dist
// directory so a new Sites archive cannot retain stale client or worker files.
await rm(resolve(import.meta.dirname, '../dist'), {
  force: true,
  recursive: true,
})
