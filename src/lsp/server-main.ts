/**
 * The language server's process entry point.
 *
 * Nothing but the wiring from a real stdio/IPC connection to the server itself, so that
 * everything worth testing lives in `createServer` and can be driven over an in-memory
 * transport instead of a process.
 * @module
 */

import { createConnection } from "vscode-languageserver/node";
import { createServer } from "./server";

const connection = createConnection();
createServer(connection);
connection.listen();
