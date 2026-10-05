/**
 * Error serialization utilities for MessagePort communication.
 */

export interface SerializedError {
  message: string;
  stack?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Serializes an error object for transmission over MessagePort.
 *
 * @param error - The error object to serialize.
 * @returns The serialized error object.
 */
export function serializeError(error: Error | string): SerializedError {
  if (typeof error === "string") {
    return { message: error };
  }
  return {
    ...error,
    message: error.message,
    stack: error.stack,
    name: error.name,
  };
}

/**
 * Deserializes an error object received from MessagePort.
 *
 * @param error - The error object or error message to deserialize.
 * @returns The deserialized Error instance.
 */
export function deserializeError(error: SerializedError | string): Error {
  if (typeof error === "string") {
    return new Error(error);
  }
  const err = new Error(error.message);
  if (error.stack) err.stack = error.stack;
  if (error.name) err.name = error.name;
  return Object.assign(err, error);
}
