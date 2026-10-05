import type { FsmStateHandler, FsmTransition } from "./types.js";

/**
 * Finite State Machine implementation for Git transport protocol.
 *
 * The FSM uses a tuple-based transition format where:
 * - Empty string ("") as source state indicates the initial/entry state
 * - Empty string ("") as target state indicates the final/exit state
 *
 * @template C - The context type passed to all state handlers
 *
 * @example
 * ```ts
 * const transitions: FsmTransition[] = [
 *   ["", "START", "READ_REFS"],
 *   ["READ_REFS", "REFS_RECEIVED", "SEND_WANTS"],
 *   ["SEND_WANTS", "DONE", ""],
 * ];
 *
 * const handlers = new Map([
 *   ["", async () => "START"],
 *   ["READ_REFS", async (ctx) => { ... return "REFS_RECEIVED"; }],
 *   ["SEND_WANTS", async (ctx) => { ... return "DONE"; }],
 * ]);
 *
 * const fsm = new Fsm(transitions, handlers);
 * await fsm.run(context);
 * ```
 */
export class Fsm<C> {
  private currentState = "";
  private readonly transitionIndex: Map<string, Map<string, string>>;

  /**
   * Creates a new FSM instance.
   *
   * @param transitions - Array of [source, event, target] transition tuples
   * @param handlers - Map of state names to handler functions
   */
  constructor(
    readonly transitions: FsmTransition[],
    private readonly handlers: Map<string, FsmStateHandler<C>>,
  ) {
    // Build transition index for O(1) lookup
    this.transitionIndex = new Map();
    for (const [source, event, target] of transitions) {
      let stateTransitions = this.transitionIndex.get(source);
      if (!stateTransitions) {
        stateTransitions = new Map();
        this.transitionIndex.set(source, stateTransitions);
      }
      stateTransitions.set(event, target);
    }
  }

  /**
   * Gets the current state of the FSM.
   */
  getState(): string {
    return this.currentState;
  }

  /**
   * Sets the FSM to a specific state.
   *
   * Useful for:
   * - Resuming FSM execution at a specific point
   * - HTTP protocol adaptation where state spans request/response boundaries
   * - Testing specific state transitions
   *
   * @param state - The state to set
   */
  setState(state: string): void {
    this.currentState = state;
  }

  /**
   * Runs the FSM until it reaches a final state ("") or a stop state.
   *
   * Stop states allow breaking FSM execution at specific points, useful for:
   * - HTTP smart protocol where refs are sent in GET, negotiation in POST
   * - Yielding control between protocol phases
   * - Testing intermediate states
   *
   * @param context - The context passed to all handlers
   * @param stopStates - Optional states where execution should pause
   * @returns true if reached final or stop state, false if no valid transition
   *
   * @example
   * ```ts
   * // Run to completion
   * await fsm.run(context);
   *
   * // Run until specific state (HTTP GET /info/refs)
   * await fsm.run(context, "READ_WANTS");
   *
   * // Resume from where we stopped (HTTP POST /git-upload-pack)
   * await fsm.run(context);
   * ```
   */
  async run(context: C, ...stopStates: string[]): Promise<boolean> {
    const stopSet = new Set(stopStates);

    // Run while NOT at a stop state
    while (!stopSet.has(this.currentState)) {
      // Get handler for current state
      const handler = this.handlers.get(this.currentState);
      if (!handler) {
        throw new FsmError(`No handler for state: "${this.currentState}"`, this.currentState);
      }

      // Execute handler to get event
      const event = await handler(context);

      // Look up transition
      const stateTransitions = this.transitionIndex.get(this.currentState);
      if (!stateTransitions) {
        // No transitions defined from this state
        return false;
      }

      const nextState = stateTransitions.get(event);
      if (nextState === undefined) {
        // No transition for this event from current state
        throw new FsmError(
          `No transition for event "${event}" from state "${this.currentState}"`,
          this.currentState,
          event,
        );
      }

      // Final state reached
      if (nextState === "") {
        this.currentState = "";
        return true;
      }

      this.currentState = nextState;
    }

    // Reached a stop state
    return true;
  }

  /**
   * Resets the FSM to its initial state ("").
   */
  reset(): void {
    this.currentState = "";
  }
}

/**
 * Error thrown when FSM encounters an invalid state or transition.
 */
export class FsmError extends Error {
  constructor(
    message: string,
    public readonly state: string,
    public readonly event?: string,
  ) {
    super(message);
    this.name = "FsmError";
  }
}
