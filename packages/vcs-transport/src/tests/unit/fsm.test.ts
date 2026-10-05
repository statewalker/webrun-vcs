import { describe, expect, it } from "vitest";
import { Fsm, FsmError, type FsmStateHandler, type FsmTransition } from "../../fsm/index.js";

describe("Fsm", () => {
  // Simple test context
  interface TestContext {
    steps: string[];
    values: Map<string, unknown>;
  }

  function createContext(): TestContext {
    return { steps: [], values: new Map() };
  }

  describe("basic transitions", () => {
    it("runs from initial to final state", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "STEP_A"],
        ["STEP_A", "NEXT", "STEP_B"],
        ["STEP_B", "DONE", ""],
      ];

      const ctx = createContext();
      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        [
          "",
          () => {
            ctx.steps.push("init");
            return "START";
          },
        ],
        [
          "STEP_A",
          () => {
            ctx.steps.push("A");
            return "NEXT";
          },
        ],
        [
          "STEP_B",
          () => {
            ctx.steps.push("B");
            return "DONE";
          },
        ],
      ]);

      const fsm = new Fsm(transitions, handlers);
      const result = await fsm.run(ctx);

      expect(result).toBe(true);
      expect(fsm.getState()).toBe("");
      expect(ctx.steps).toEqual(["init", "A", "B"]);
    });

    it("handles async handlers", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "ASYNC_STEP"],
        ["ASYNC_STEP", "DONE", ""],
      ];

      const ctx = createContext();
      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        [
          "",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            ctx.steps.push("init");
            return "START";
          },
        ],
        [
          "ASYNC_STEP",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            ctx.steps.push("async");
            return "DONE";
          },
        ],
      ]);

      const fsm = new Fsm(transitions, handlers);
      await fsm.run(ctx);

      expect(ctx.steps).toEqual(["init", "async"]);
    });
  });

  describe("stop states", () => {
    it("pauses at stop state", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "PHASE_1"],
        ["PHASE_1", "NEXT", "PHASE_2"],
        ["PHASE_2", "NEXT", "PHASE_3"],
        ["PHASE_3", "DONE", ""],
      ];

      const ctx = createContext();
      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        [
          "",
          () => {
            ctx.steps.push("init");
            return "START";
          },
        ],
        [
          "PHASE_1",
          () => {
            ctx.steps.push("P1");
            return "NEXT";
          },
        ],
        [
          "PHASE_2",
          () => {
            ctx.steps.push("P2");
            return "NEXT";
          },
        ],
        [
          "PHASE_3",
          () => {
            ctx.steps.push("P3");
            return "DONE";
          },
        ],
      ]);

      const fsm = new Fsm(transitions, handlers);

      // Run until PHASE_2
      const result1 = await fsm.run(ctx, "PHASE_2");
      expect(result1).toBe(true);
      expect(fsm.getState()).toBe("PHASE_2");
      expect(ctx.steps).toEqual(["init", "P1"]);

      // Resume and run to completion
      const result2 = await fsm.run(ctx);
      expect(result2).toBe(true);
      expect(fsm.getState()).toBe("");
      expect(ctx.steps).toEqual(["init", "P1", "P2", "P3"]);
    });

    it("supports multiple stop states", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "A"],
        ["A", "TO_B", "B"],
        ["A", "TO_C", "C"],
        ["B", "DONE", ""],
        ["C", "DONE", ""],
      ];

      const ctx = createContext();
      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        ["A", () => "TO_B"],
        ["B", () => "DONE"],
        ["C", () => "DONE"],
      ]);

      const fsm = new Fsm(transitions, handlers);
      const result = await fsm.run(ctx, "B", "C");

      expect(result).toBe(true);
      expect(["B", "C"]).toContain(fsm.getState());
    });
  });

  describe("setState", () => {
    it("allows setting state directly", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "PHASE_1"],
        ["PHASE_1", "NEXT", "PHASE_2"],
        ["PHASE_2", "DONE", ""],
      ];

      const ctx = createContext();
      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        [
          "",
          () => {
            ctx.steps.push("init");
            return "START";
          },
        ],
        [
          "PHASE_1",
          () => {
            ctx.steps.push("P1");
            return "NEXT";
          },
        ],
        [
          "PHASE_2",
          () => {
            ctx.steps.push("P2");
            return "DONE";
          },
        ],
      ]);

      const fsm = new Fsm(transitions, handlers);

      // Skip initial state, start from PHASE_2
      fsm.setState("PHASE_2");
      await fsm.run(ctx);

      expect(ctx.steps).toEqual(["P2"]);
      expect(fsm.getState()).toBe("");
    });

    it("enables HTTP-style request/response split", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "SEND_REFS"],
        ["SEND_REFS", "REFS_SENT", "READ_WANTS"],
        ["READ_WANTS", "WANTS_RECEIVED", "SEND_PACK"],
        ["SEND_PACK", "DONE", ""],
      ];

      const ctx = createContext();
      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        [
          "",
          () => {
            ctx.steps.push("init");
            return "START";
          },
        ],
        [
          "SEND_REFS",
          () => {
            ctx.steps.push("refs");
            return "REFS_SENT";
          },
        ],
        [
          "READ_WANTS",
          () => {
            ctx.steps.push("wants");
            return "WANTS_RECEIVED";
          },
        ],
        [
          "SEND_PACK",
          () => {
            ctx.steps.push("pack");
            return "DONE";
          },
        ],
      ]);

      const fsm = new Fsm(transitions, handlers);

      // GET /info/refs - run until READ_WANTS
      await fsm.run(ctx, "READ_WANTS");
      expect(ctx.steps).toEqual(["init", "refs"]);
      expect(fsm.getState()).toBe("READ_WANTS");

      // POST /git-upload-pack - create new FSM, set state, continue
      const fsm2 = new Fsm(transitions, handlers);
      fsm2.setState("READ_WANTS");
      await fsm2.run(ctx);

      expect(ctx.steps).toEqual(["init", "refs", "wants", "pack"]);
    });
  });

  describe("error handling", () => {
    it("throws FsmError for missing handler", async () => {
      const transitions: FsmTransition[] = [["", "START", "MISSING_HANDLER"]];

      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        // No handler for MISSING_HANDLER
      ]);

      const fsm = new Fsm(transitions, handlers);

      await expect(fsm.run(createContext())).rejects.toThrow(FsmError);
      await expect(fsm.run(createContext())).rejects.toThrow("No handler for state");
    });

    it("throws FsmError for invalid event", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "STATE_A"],
        ["STATE_A", "VALID_EVENT", ""],
      ];

      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        ["STATE_A", () => "INVALID_EVENT"], // Returns event with no transition
      ]);

      const fsm = new Fsm(transitions, handlers);

      await expect(fsm.run(createContext())).rejects.toThrow(FsmError);
      await expect(fsm.run(createContext())).rejects.toThrow(
        'No transition for event "INVALID_EVENT"',
      );
    });

    it("returns false when no transitions exist from state", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "DEAD_END"],
        // No transitions from DEAD_END
      ];

      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        ["DEAD_END", () => "ANY_EVENT"],
      ]);

      const fsm = new Fsm(transitions, handlers);
      const result = await fsm.run(createContext());

      expect(result).toBe(false);
      expect(fsm.getState()).toBe("DEAD_END");
    });
  });

  describe("reset", () => {
    it("resets to initial state", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "STATE_A"],
        ["STATE_A", "DONE", ""],
      ];

      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        ["STATE_A", () => "DONE"],
      ]);

      const fsm = new Fsm(transitions, handlers);

      await fsm.run(createContext());
      expect(fsm.getState()).toBe("");

      fsm.setState("STATE_A");
      expect(fsm.getState()).toBe("STATE_A");

      fsm.reset();
      expect(fsm.getState()).toBe("");
    });
  });

  describe("conditional transitions", () => {
    it("supports multiple events from same state", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "CHECK"],
        ["CHECK", "SUCCESS", "SUCCESS_STATE"],
        ["CHECK", "FAILURE", "FAILURE_STATE"],
        ["SUCCESS_STATE", "DONE", ""],
        ["FAILURE_STATE", "DONE", ""],
      ];

      const ctx = createContext();
      ctx.values.set("shouldSucceed", true);

      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        ["CHECK", (c) => (c.values.get("shouldSucceed") ? "SUCCESS" : "FAILURE")],
        [
          "SUCCESS_STATE",
          () => {
            ctx.steps.push("success");
            return "DONE";
          },
        ],
        [
          "FAILURE_STATE",
          () => {
            ctx.steps.push("failure");
            return "DONE";
          },
        ],
      ]);

      // Test success path
      const fsm1 = new Fsm(transitions, handlers);
      await fsm1.run(ctx);
      expect(ctx.steps).toEqual(["success"]);

      // Test failure path
      ctx.steps = [];
      ctx.values.set("shouldSucceed", false);
      const fsm2 = new Fsm(transitions, handlers);
      await fsm2.run(ctx);
      expect(ctx.steps).toEqual(["failure"]);
    });

    it("supports looping transitions", async () => {
      const transitions: FsmTransition[] = [
        ["", "START", "LOOP"],
        ["LOOP", "CONTINUE", "LOOP"],
        ["LOOP", "EXIT", ""],
      ];

      const ctx = createContext();
      let loopCount = 0;

      const handlers = new Map<string, FsmStateHandler<TestContext>>([
        ["", () => "START"],
        [
          "LOOP",
          () => {
            loopCount++;
            ctx.steps.push(`loop-${loopCount}`);
            return loopCount >= 3 ? "EXIT" : "CONTINUE";
          },
        ],
      ]);

      const fsm = new Fsm(transitions, handlers);
      await fsm.run(ctx);

      expect(ctx.steps).toEqual(["loop-1", "loop-2", "loop-3"]);
    });
  });
});
