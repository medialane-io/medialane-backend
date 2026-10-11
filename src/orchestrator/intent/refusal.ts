export class IntentRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "IntentRefusal";
  }
}
