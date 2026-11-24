// Typed errors thrown by services. Routes can map `code` to user-facing behaviour;
// `message` is always a Russian, user-presentable sentence.

export class AppError extends Error {
  /**
   * @param {string} code machine code, e.g. "out_of_stock"
   * @param {string} message user-facing (Russian)
   * @param {number} [status] suggested HTTP status
   * @param {object} [details]
   */
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

export const notFound = (what = 'Запись') => new AppError('not_found', `${what} не найдена`, 404);
export const invalid = (message, details) => new AppError('validation', message, 422, details);
