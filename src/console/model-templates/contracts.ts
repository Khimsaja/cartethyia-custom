// Console model-template domain: request/response contracts.
//
// A template is a named model whitelist preset. Validation mirrors the
// semantics of a key's whitelist `model_list`: the list holds catalog model ids,
// and an empty list means "every model". Duplicates are collapsed on write
// (order of first appearance wins) so a stored template is always the exact
// list the key form will apply.
import { ConsoleDomainError } from "../shared/errors";
import type { ModelTemplate } from "../../persistence/stores/model-template-store";

const NAME_MAX_LENGTH = 80;
const MODEL_ID_MAX_LENGTH = 200;
const MODELS_MAX_COUNT = 500;

export interface CreateModelTemplateRequest {
  readonly name: string;
  readonly models: readonly string[];
}

export interface UpdateModelTemplateRequest {
  readonly name?: string;
  readonly models?: readonly string[];
}

export interface ModelTemplateResponse {
  readonly id: string;
  readonly name: string;
  readonly models: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Result of pushing a template's model list onto every key linked to it. */
export interface ModelTemplateSyncResponse {
  readonly templateId: string;
  readonly updatedKeys: readonly { readonly id: string; readonly label: string }[];
  /** Linked keys left alone (revoked, share-mode, or share children). */
  readonly skippedCount: number;
}

function invalid(message: string): ConsoleDomainError {
  return new ConsoleDomainError("invalid_template", 400, message);
}

function parseName(value: unknown): string {
  if (typeof value !== "string") throw invalid("Template name must be a string");
  const name = value.trim();
  if (name.length === 0) throw invalid("Template name must not be empty");
  if (name.length > NAME_MAX_LENGTH) {
    throw invalid(`Template name must be at most ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

function parseModels(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid("Template models must be an array of model ids");
  if (value.length > MODELS_MAX_COUNT) {
    throw invalid(`Template models must hold at most ${MODELS_MAX_COUNT} entries`);
  }
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw invalid("Template models must be an array of model ids");
    const model = entry.trim();
    if (model.length === 0) throw invalid("Template model ids must not be empty");
    if (model.length > MODEL_ID_MAX_LENGTH) {
      throw invalid(`Template model ids must be at most ${MODEL_ID_MAX_LENGTH} characters`);
    }
    if (seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseCreateModelTemplateRequest(body: unknown): CreateModelTemplateRequest {
  const record = asRecord(body, "Create template request");
  return { name: parseName(record.name), models: parseModels(record.models ?? []) };
}

export function parseUpdateModelTemplateRequest(body: unknown): UpdateModelTemplateRequest {
  const record = asRecord(body, "Update template request");
  const name = record.name === undefined ? undefined : parseName(record.name);
  const models = record.models === undefined ? undefined : parseModels(record.models);
  if (name === undefined && models === undefined) {
    throw invalid("Update template request must change the name or the models");
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(models !== undefined ? { models } : {}),
  };
}

export function toModelTemplateResponse(record: ModelTemplate): ModelTemplateResponse {
  return {
    id: record.id,
    name: record.name,
    models: [...record.models],
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
