/**
 * URI arithmetic the server does on the client's own strings.
 * @module
 */

/**
 * Names a sibling file by swapping the URI's extension.
 *
 * Rebuilding the URI from the filesystem path instead would re-encode it, and a client
 * that sent a lower-cased Windows drive letter would stop recognizing its own document.
 * The only sibling this server asks for is a template's component, so an extension swap
 * is the whole transformation.
 * @param documentUri The URI as the client sent it.
 * @param extension The new extension, with its leading dot.
 */
export function siblingUri(documentUri: string, extension: string): string {
  return documentUri.replace(/\.[^./\\]*$/, extension);
}
