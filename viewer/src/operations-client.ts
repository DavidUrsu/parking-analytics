import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./operations.schema.json";
import type { OperationsResponse } from "./operations-types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<OperationsResponse>(schema);

export function parseOperations(value: unknown): OperationsResponse {
  if (!validate(value)) {
    const details = validate.errors?.slice(0, 3).map(
      (issue) => `${issue.instancePath || "/"}: ${issue.message}`,
    ).join("; ");
    throw new Error(`Invalid operations response: ${details}`);
  }
  return value;
}

function errorDetail(value: unknown): string {
  if (typeof value === "object" && value !== null && "detail" in value) {
    if (typeof value.detail === "string") return value.detail;
    if (Array.isArray(value.detail)) {
      return value.detail.flatMap((issue: unknown) => {
        if (typeof issue === "object" && issue !== null && "msg" in issue
            && typeof issue.msg === "string") return [issue.msg];
        return [];
      }).join("; ");
    }
  }
  return "The local operations API did not return a valid response.";
}

export async function request(
  path: string, payload?: unknown, signal?: AbortSignal,
): Promise<OperationsResponse> {
  const response = await fetch(`/api/${path}`, {
    method: payload === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: payload === undefined ? {} : { "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return parseOperations(await privateResponse(response));
}

export async function privateResponse(response: Response): Promise<unknown> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`Expected API JSON (HTTP ${response.status}). Start parking serve and check the /api proxy.`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorDetail(data)}`);
  return data;
}
