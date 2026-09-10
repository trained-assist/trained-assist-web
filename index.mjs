// Cloud Functions (2nd gen) entry point. Registers the raw HTTP handler from
// server.mjs with the Functions Framework so it runs identically to local dev.
import functions from '@google-cloud/functions-framework';
import { handler } from './server.mjs';

functions.http('app', handler);
