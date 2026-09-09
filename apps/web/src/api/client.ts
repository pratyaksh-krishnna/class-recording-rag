import type {
  ApiErrorBody,
  CatalogResponse,
  ChatRequest,
  ChatResponse,
  ConversationDetailResponse,
  ConversationListResponse,
} from '@rag/shared';
import { apiBaseUrl, cohortId, userId } from '../env';
import { ApiError } from './errors';

interface RequestOptions {
  signal?: AbortSignal;
}

function identityHeaders(): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-user-id': userId,
    'x-cohort-id': cohortId,
  };
}

async function parseApiError(response: Response): Promise<ApiError> {
  const status = response.status;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error?.code && body.error.message) {
      return new ApiError(
        body.error.code,
        body.error.message,
        status,
        body.error.requestId ?? null,
      );
    }
  } catch {
    // Non-JSON body — fall through to a legible generic error.
  }

  return new ApiError(
    'INTERNAL_ERROR',
    `Request failed with status ${status}.`,
    status,
    null,
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...identityHeaders(),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return (await response.json()) as T;
}

export function postChat(body: ChatRequest, options?: RequestOptions): Promise<ChatResponse> {
  return requestJson<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: options?.signal,
  });
}

export function getConversation(id: string): Promise<ConversationDetailResponse> {
  return requestJson<ConversationDetailResponse>(`/api/conversations/${id}`);
}

export function listConversations(): Promise<ConversationListResponse> {
  return requestJson<ConversationListResponse>('/api/conversations');
}

export function getCatalog(cohort: string): Promise<CatalogResponse> {
  return requestJson<CatalogResponse>(`/api/cohorts/${cohort}/catalog`);
}
