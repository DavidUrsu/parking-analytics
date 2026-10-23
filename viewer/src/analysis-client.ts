import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "./analysis.schema.json";
import type { AnalysisResponse } from "./analysis-types";
import { privateResponse } from "./operations-client";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<AnalysisResponse>(schema);

export function parseAnalysis(value: unknown): AnalysisResponse {
  if (!validate(value)) {
    throw new Error(`Invalid analysis response: ${validate.errors?.slice(0, 3).map(
      (error) => `${error.instancePath}: ${error.message}`,
    ).join("; ")}`);
  }
  return value;
}

export async function analysisRequest(path: string, body?: unknown): Promise<AnalysisResponse> {
  const response = await fetch(`/api/analysis/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parseAnalysis(await privateResponse(response));
}

export async function uploadVideo(
  file: File, contentKind: "recording" | "synthetic_test", signal?: AbortSignal,
): Promise<AnalysisResponse> {
  const response = await fetch("/api/analysis/videos", {
    method: "POST", body: file, signal, cache: "no-store",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Analysis-Permission": "confirmed",
      "X-Upload-Name": encodeURIComponent(file.name),
      "X-Analysis-Content-Kind": contentKind,
    },
  });
  return parseAnalysis(await privateResponse(response));
}
