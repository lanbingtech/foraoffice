import type { DocsFileAccess } from './file-access'
import { readPickedImage } from './picked-image'

/** Same byte validation and embedding format as manual insertion, under host-granted read access. */
export async function readAuthorizedImage(access: DocsFileAccess, path: string) {
  const authorized = await access.authorize(path, 'read')
  const image = await readPickedImage(authorized)
  await access.authorize(path, 'read')
  await access.authorize(authorized, 'read')
  return image
}
