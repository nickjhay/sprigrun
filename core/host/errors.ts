/** A rejected publication, never an acknowledgement of the losing action. */
export class AlreadyStored extends Error {
  readonly path: string;
  constructor(path: string) { super('already_stored'); this.path = path; }
}
