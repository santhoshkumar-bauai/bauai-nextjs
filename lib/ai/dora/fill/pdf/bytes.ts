/**
 * unpdf rejects a Node Buffer outright ("Please provide binary data as
 * `Uint8Array`") even though Buffer subclasses it, and pdf.js may detach the
 * ArrayBuffer it is handed. Every source in this codebase arrives as a Buffer
 * (getObjectBuffer, streamed uploads), so normalize at the library boundary.
 *
 * This COPIES rather than taking a view. A view would still satisfy unpdf's
 * constructor check, but pdf.js transferring the underlying ArrayBuffer would
 * then detach the caller's buffer — and source immutability is a guarantee the
 * fill engines make.
 */
export function toPlainBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}
