/** A source was removed from the caller's authorized collection during an operation. */
export class ResourceAccessError extends Error {
  override readonly name = 'ResourceAccessError'
}
