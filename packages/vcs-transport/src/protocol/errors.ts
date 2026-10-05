/**
 * Transport-related error classes.
 */

/**
 * Base error for all transport operations.
 */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Error in the git protocol communication.
 */
export class PackProtocolError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "PackProtocolError";
  }
}

/**
 * Error parsing pkt-line format.
 */
export class PacketLineError extends TransportError {
  readonly header?: string;

  constructor(message: string, header?: string) {
    super(message);
    this.name = "PacketLineError";
    this.header = header;
  }
}

/**
 * Server sent an error message.
 */
export class ServerError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

/**
 * Network connection error.
 */
export class ConnectionError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/**
 * Authentication required or failed.
 */
export class AuthenticationError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/**
 * Repository not found.
 */
export class RepositoryNotFoundError extends TransportError {
  readonly url: string;

  constructor(url: string) {
    super(`Repository not found: ${url}`);
    this.name = "RepositoryNotFoundError";
    this.url = url;
  }
}
