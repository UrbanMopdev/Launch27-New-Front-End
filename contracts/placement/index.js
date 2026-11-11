// Loads the placement contract (openapi.yaml) and validates request and response bodies
// against it. Apps use this in their own tests; the hub can use it to check what apps send.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const SPEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'openapi.yaml');
export const BASE_PATH = '/api/placement/v1';
const SCHEMA_ID = 'placement-v1';

let cached;

/** The parsed OpenAPI document. */
export function loadSpec() {
  cached ??= parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  return cached;
}

let ajv;
function getAjv() {
  if (ajv) return ajv;
  const spec = loadSpec();
  // OpenAPI keeps schemas under components/schemas; JSON Schema validators expect $defs.
  const defs = JSON.parse(JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', '#/$defs/'));
  ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats.default(ajv);
  ajv.addSchema({ $id: SCHEMA_ID, $defs: defs });
  return ajv;
}

/** Names of the schemas in the contract (Quote, Slot, Error...). */
export function schemaNames() {
  return Object.keys(loadSpec().components.schemas);
}

/**
 * Validates a value against a named schema.
 * @returns {string[]} problems, empty when valid
 */
export function validate(schemaName, value) {
  if (!loadSpec().components.schemas[schemaName]) throw new Error(`Unknown schema: ${schemaName}`);
  const check = getAjv().getSchema(`${SCHEMA_ID}#/$defs/${schemaName}`);
  if (check(value)) return [];
  return check.errors.map((e) => `${schemaName}${e.instancePath || ''} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}

function resolve(obj) {
  if (obj?.$ref) {
    const parts = obj.$ref.replace(/^#\//, '').split('/');
    return resolve(parts.reduce((node, key) => node[key], loadSpec()));
  }
  return obj;
}

function schemaNameOf(content) {
  const ref = content?.['application/json']?.schema?.$ref;
  return ref ? ref.split('/').pop() : null;
}

/** Finds an operation by its operationId. */
export function operation(operationId) {
  for (const [p, methods] of Object.entries(loadSpec().paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.operationId === operationId) return { path: p, method: method.toUpperCase(), op };
    }
  }
  throw new Error(`Unknown operation: ${operationId}`);
}

/** The schema name a request body for this operation must match, or null if it takes none. */
export function requestSchemaName(operationId) {
  return schemaNameOf(resolve(operation(operationId).op.requestBody)?.content);
}

/**
 * Validates a response: the status must be one the operation declares (or an error status
 * when it declares `default`), and the body must match that status's schema.
 * @returns {string[]} problems, empty when valid
 */
export function validateResponse(operationId, status, body) {
  const { op } = operation(operationId);
  const declared = op.responses[String(status)];
  const isError = status >= 400;
  const response = resolve(declared ?? (isError ? op.responses.default ?? loadSpec().components.responses.Error : undefined));
  if (!response) return [`${operationId}: status ${status} is not allowed (expected ${Object.keys(op.responses).join(', ')})`];
  const name = schemaNameOf(response.content);
  if (!name) return body === undefined || body === null || body === '' ? [] : [`${operationId}: status ${status} must have no body`];
  return validate(name, body);
}
