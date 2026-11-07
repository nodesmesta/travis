export class DomainInvariantError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "DomainInvariantError";
    this.code = code;
  }
}
