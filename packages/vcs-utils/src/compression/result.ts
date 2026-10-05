// /**
//  * Result type for error handling
//  *
//  * Provides a consistent pattern for operations that can fail,
//  * avoiding exceptions in favor of explicit error handling.
//  */

// /**
//  * Success result
//  */
// export interface Success<T> {
//   success: true;
//   value: T;
//   warnings: string[];
// }

// /**
//  * Failure result
//  */
// export interface Failure<E = Error> {
//   success: false;
//   errors: E[];
//   warnings: string[];
// }

// /**
//  * Result type representing success or failure
//  */
// export type Result<T, E = Error> = Success<T> | Failure<E>;

// /**
//  * Create a success result
//  *
//  * @param value The success value
//  * @param warnings Optional warnings
//  * @returns Success result
//  */
// export function ok<T>(value: T, warnings: string[] = []): Success<T> {
//   return { success: true, value, warnings };
// }

// /**
//  * Create a failure result
//  *
//  * @param errors The errors
//  * @param warnings Optional warnings
//  * @returns Failure result
//  */
// export function err<E = Error>(errors: E[], warnings: string[] = []): Failure<E> {
//   return { success: false, errors, warnings };
// }

// /**
//  * Create a failure result from a single error
//  *
//  * @param error The error
//  * @param warnings Optional warnings
//  * @returns Failure result
//  */
// export function errSingle<E = Error>(error: E, warnings: string[] = []): Failure<E> {
//   return { success: false, errors: [error], warnings };
// }

// /**
//  * Check if result is success
//  */
// export function isOk<T, E>(result: Result<T, E>): result is Success<T> {
//   return result.success;
// }

// /**
//  * Check if result is failure
//  */
// export function isErr<T, E>(result: Result<T, E>): result is Failure<E> {
//   return !result.success;
// }

// /**
//  * Map a success value to a new value
//  *
//  * @param result Input result
//  * @param fn Mapping function
//  * @returns Mapped result
//  */
// export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
//   if (result.success) {
//     return ok(fn(result.value), result.warnings);
//   }
//   return result;
// }

// /**
//  * Chain a result with a function that returns a result
//  *
//  * @param result Input result
//  * @param fn Function that returns a result
//  * @returns Chained result
//  */
// export function andThen<T, U, E>(
//   result: Result<T, E>,
//   fn: (value: T) => Result<U, E>,
// ): Result<U, E> {
//   if (result.success) {
//     const nextResult = fn(result.value);
//     // Combine warnings
//     if (nextResult.success) {
//       return ok(nextResult.value, [...result.warnings, ...nextResult.warnings]);
//     }
//     return { ...nextResult, warnings: [...result.warnings, ...nextResult.warnings] };
//   }
//   return result;
// }

// /**
//  * Unwrap a result, throwing if it's an error
//  *
//  * @param result Result to unwrap
//  * @returns The success value
//  * @throws If result is an error
//  */
// export function unwrap<T, E>(result: Result<T, E>): T {
//   if (result.success) {
//     return result.value;
//   }
//   throw new Error(
//     `Unwrap failed: ${result.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(", ")}`,
//   );
// }

// /**
//  * Unwrap a result or return a default value
//  *
//  * @param result Result to unwrap
//  * @param defaultValue Default value if result is an error
//  * @returns The success value or default
//  */
// export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
//   return result.success ? result.value : defaultValue;
// }

// /**
//  * Unwrap a result or compute a default value
//  *
//  * @param result Result to unwrap
//  * @param fn Function to compute default value
//  * @returns The success value or computed default
//  */
// export function unwrapOrElse<T, E>(result: Result<T, E>, fn: (errors: E[]) => T): T {
//   return result.success ? result.value : fn(result.errors);
// }

// /**
//  * Convert a throwing function to one that returns a Result
//  *
//  * @param fn Function that might throw
//  * @returns Function that returns a Result
//  */
// export function tryCatch<T, Args extends unknown[]>(
//   fn: (...args: Args) => T,
// ): (...args: Args) => Result<T> {
//   return (...args: Args): Result<T> => {
//     try {
//       return ok(fn(...args));
//     } catch (error) {
//       return errSingle(error instanceof Error ? error : new Error(String(error)));
//     }
//   };
// }

// /**
//  * Convert an async throwing function to one that returns a Result
//  *
//  * @param fn Async function that might throw
//  * @returns Async function that returns a Result
//  */
// export function tryAsync<T, Args extends unknown[]>(
//   fn: (...args: Args) => Promise<T>,
// ): (...args: Args) => Promise<Result<T>> {
//   return async (...args: Args): Promise<Result<T>> => {
//     try {
//       return ok(await fn(...args));
//     } catch (error) {
//       return errSingle(error instanceof Error ? error : new Error(String(error)));
//     }
//   };
// }
