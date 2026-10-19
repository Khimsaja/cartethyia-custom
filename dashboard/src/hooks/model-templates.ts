import { consoleRequest } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type {
  CreateModelTemplateRequest,
  UpdateModelTemplateRequest,
  ModelTemplateResponse,
  ModelTemplateSyncResponse,
} from "../data/contracts";
import { queryKeys } from "../data/query-keys";
import { DASHBOARD_QUERY_OPTIONS } from "../data/query-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** Lists this tenant's model templates (named model-list presets). */
export function useModelTemplates() {
  return useQuery<ModelTemplateResponse[], ApiErrorShape>({
    queryKey: queryKeys.modelTemplates.all,
    queryFn: () => consoleRequest<ModelTemplateResponse[]>("/model-templates"),
    ...DASHBOARD_QUERY_OPTIONS,
  });
}

/** Creates a model template and refreshes the list. */
export function useCreateModelTemplate() {
  const queryClient = useQueryClient();
  return useMutation<ModelTemplateResponse, ApiErrorShape, CreateModelTemplateRequest>({
    mutationFn: (request) =>
      consoleRequest<ModelTemplateResponse>("/model-templates", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelTemplates.all });
    },
  });
}

/** Updates a model template's name and/or model list. */
export function useUpdateModelTemplate() {
  const queryClient = useQueryClient();
  return useMutation<
    ModelTemplateResponse,
    ApiErrorShape,
    { templateId: string; request: UpdateModelTemplateRequest }
  >({
    mutationFn: ({ templateId, request }) =>
      consoleRequest<ModelTemplateResponse>(
        `/model-templates/${encodeURIComponent(templateId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(request),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelTemplates.all });
      // Keys mirroring the template may show the new name.
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

/** Deletes a model template and refreshes the list. */
export function useDeleteModelTemplate() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (templateId) =>
      consoleRequest<{ success: boolean }>(
        `/model-templates/${encodeURIComponent(templateId)}`,
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelTemplates.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}

/**
 * Pushes a template's model list onto every key linked to it, then refreshes
 * both the template list and the key list.
 */
export function useSyncModelTemplate() {
  const queryClient = useQueryClient();
  return useMutation<ModelTemplateSyncResponse, ApiErrorShape, string>({
    mutationFn: (templateId) =>
      consoleRequest<ModelTemplateSyncResponse>(
        `/model-templates/${encodeURIComponent(templateId)}/sync`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelTemplates.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all });
    },
  });
}
