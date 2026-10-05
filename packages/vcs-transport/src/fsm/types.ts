/**
 * FSM Transition tuple: [sourceState, event, targetState]
 *
 * Special values:
 * - "" as sourceState = initial state (entry point)
 * - "" as targetState = final state (exit)
 *
 * @example
 * ```ts
 * const transitions: FsmTransition[] = [
 *   ["", "START", "READING"],           // Entry point
 *   ["READING", "DATA", "PROCESSING"],  // Normal transition
 *   ["PROCESSING", "DONE", ""],         // Exit to final state
 * ];
 * ```
 */
export type FsmTransition = [sourceState: string, event: string, targetState: string];

/**
 * Handler function for FSM states.
 *
 * Receives the context and returns an event string that triggers the next transition.
 * Can be async for I/O operations.
 *
 * @template C - The context type passed to all handlers
 * @returns Event string that determines the next state transition
 *
 * @example
 * ```ts
 * const handler: FsmStateHandler<ProcessContext> = async (ctx) => {
 *   const data = await ctx.transport.readPktLine();
 *   if (data.type === "flush") return "FLUSH_RECEIVED";
 *   return "DATA_RECEIVED";
 * };
 * ```
 */
export type FsmStateHandler<C> = (context: C) => string | Promise<string>;
