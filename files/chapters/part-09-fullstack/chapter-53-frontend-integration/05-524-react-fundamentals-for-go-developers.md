## 53.4 React Fundamentals for Go Developers

### TypeScript API Client

A typed API client generated from the Go backend's response contracts eliminates the class of bugs that arise when frontend and backend drift out of sync. Using TypeScript interfaces mirrored from Go structs means the compiler catches mismatched field names or missing error branches before they reach users. The client below wraps `fetch` with typed helpers for every endpoint, centralizing authentication headers and error normalization.

```typescript
// src/api/client.ts
import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';

// API Response types matching Go backend
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, string>;
  };
  meta?: {
    page?: number;
    per_page?: number;
    total?: number;
    total_pages?: number;
    has_more?: boolean;
  };
}

// Create axios instance
const api: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for auth
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse<unknown>>) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };

    // Handle 401 - try to refresh token
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = localStorage.getItem('refresh_token');
        const response = await axios.post('/api/v1/auth/refresh', {
          refresh_token: refreshToken,
        });

        const { access_token, refresh_token: newRefresh } = response.data.data;
        localStorage.setItem('access_token', access_token);
        localStorage.setItem('refresh_token', newRefresh);

        // Retry original request
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${access_token}`;
        }
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed, redirect to login
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// API methods
export const apiClient = {
  get: async <T>(url: string, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    const response = await api.get<ApiResponse<T>>(url, config);
    return response.data;
  },

  post: async <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    const response = await api.post<ApiResponse<T>>(url, data, config);
    return response.data;
  },

  put: async <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    const response = await api.put<ApiResponse<T>>(url, data, config);
    return response.data;
  },

  patch: async <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    const response = await api.patch<ApiResponse<T>>(url, data, config);
    return response.data;
  },

  delete: async <T>(url: string, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    const response = await api.delete<ApiResponse<T>>(url, config);
    return response.data;
  },
};

export default api;
```

### Redux Toolkit Setup

Redux Toolkit's `configureStore` removes the boilerplate of setting up middleware and the Redux DevTools extension, while its `createSlice` API keeps reducers and action creators co-located with the state they manage. For a Go-backed app, the store shape mirrors the backend domain models so that API responses can be normalized and cached client-side with minimal transformation. The configuration below wires together the root reducer, RTK Query API slices, and the WebSocket middleware.

```typescript
// src/store/index.ts
import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { apiSlice } from './api/apiSlice';
import authReducer from './slices/authSlice';
import uiReducer from './slices/uiSlice';

export const store = configureStore({
  reducer: {
    [apiSlice.reducerPath]: apiSlice.reducer,
    auth: authReducer,
    ui: uiReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(apiSlice.middleware),
  devTools: import.meta.env.DEV,
});

setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

```typescript
// src/store/api/apiSlice.ts
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { RootState } from '../index';

// Base query with auth
const baseQuery = fetchBaseQuery({
  baseUrl: import.meta.env.VITE_API_URL || '/api/v1',
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.token;
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  },
});

// Base query with re-auth
const baseQueryWithReauth = async (args: any, api: any, extraOptions: any) => {
  let result = await baseQuery(args, api, extraOptions);

  if (result.error && result.error.status === 401) {
    // Try to refresh token
    const refreshResult = await baseQuery(
      {
        url: '/auth/refresh',
        method: 'POST',
        body: { refresh_token: localStorage.getItem('refresh_token') },
      },
      api,
      extraOptions
    );

    if (refreshResult.data) {
      const { access_token, refresh_token } = (refreshResult.data as any).data;
      localStorage.setItem('access_token', access_token);
      localStorage.setItem('refresh_token', refresh_token);
      api.dispatch({ type: 'auth/setToken', payload: access_token });

      // Retry original request
      result = await baseQuery(args, api, extraOptions);
    } else {
      api.dispatch({ type: 'auth/logout' });
    }
  }

  return result;
};

export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['User', 'Task', 'Project'],
  endpoints: () => ({}),
});
```

```typescript
// src/store/api/userApi.ts
import { apiSlice } from './apiSlice';

interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  created_at: string;
}

interface UsersResponse {
  success: boolean;
  data: User[];
  meta: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

interface UserResponse {
  success: boolean;
  data: User;
}

export const userApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getUsers: builder.query<UsersResponse, { page?: number; per_page?: number }>({
      query: ({ page = 1, per_page = 20 }) => `/users?page=${page}&per_page=${per_page}`,
      providesTags: (result) =>
        result
          ? [
              ...result.data.map(({ id }) => ({ type: 'User' as const, id })),
              { type: 'User', id: 'LIST' },
            ]
          : [{ type: 'User', id: 'LIST' }],
    }),

    getUser: builder.query<UserResponse, string>({
      query: (id) => `/users/${id}`,
      providesTags: (result, error, id) => [{ type: 'User', id }],
    }),

    createUser: builder.mutation<UserResponse, Partial<User>>({
      query: (body) => ({
        url: '/users',
        method: 'POST',
        body,
      }),
      invalidatesTags: [{ type: 'User', id: 'LIST' }],
    }),

    updateUser: builder.mutation<UserResponse, { id: string; data: Partial<User> }>({
      query: ({ id, data }) => ({
        url: `/users/${id}`,
        method: 'PUT',
        body: data,
      }),
      invalidatesTags: (result, error, { id }) => [{ type: 'User', id }],
    }),

    deleteUser: builder.mutation<void, string>({
      query: (id) => ({
        url: `/users/${id}`,
        method: 'DELETE',
      }),
      invalidatesTags: (result, error, id) => [
        { type: 'User', id },
        { type: 'User', id: 'LIST' },
      ],
    }),
  }),
});

export const {
  useGetUsersQuery,
  useGetUserQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useDeleteUserMutation,
} = userApi;
```

### WebSocket Hook

Encapsulating WebSocket lifecycle (connecting, reconnecting on drop, dispatching incoming messages to the Redux store) in a custom hook keeps component trees free of imperative connection management. The hook below uses a `useRef` to hold the socket instance across renders, an exponential backoff timer for reconnection, and a `useEffect` cleanup to close the connection when the component unmounts.

```typescript
// src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useState } from 'react';

interface WebSocketMessage {
  type: string;
  room?: string;
  payload: unknown;
  from?: string;
}

interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const {
    url,
    onMessage,
    onOpen,
    onClose,
    onError,
    reconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
  } = options;

  const ws = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const token = localStorage.getItem('access_token');
    const wsUrl = `${url}?token=${token}`;

    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      setIsConnected(true);
      reconnectAttempts.current = 0;
      onOpen?.();
    };

    ws.current.onclose = () => {
      setIsConnected(false);
      onClose?.();

      if (reconnect && reconnectAttempts.current < maxReconnectAttempts) {
        setTimeout(() => {
          reconnectAttempts.current++;
          connect();
        }, reconnectInterval);
      }
    };

    ws.current.onerror = (error) => {
      onError?.(error);
    };

    ws.current.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        setLastMessage(message);
        onMessage?.(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };
  }, [url, onMessage, onOpen, onClose, onError, reconnect, reconnectInterval, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
  }, []);

  const sendMessage = useCallback((type: string, payload: unknown, room?: string) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      const message: WebSocketMessage = { type, payload, room };
      ws.current.send(JSON.stringify(message));
    }
  }, []);

  const joinRoom = useCallback((room: string) => {
    sendMessage('join_room', { room });
  }, [sendMessage]);

  const leaveRoom = useCallback((room: string) => {
    sendMessage('leave_room', { room });
  }, [sendMessage]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    isConnected,
    lastMessage,
    sendMessage,
    joinRoom,
    leaveRoom,
    connect,
    disconnect,
  };
}
```

### SSE Hook

An SSE hook wraps the browser's `EventSource` API into a React-friendly interface that handles subscription, cleanup, and typed event dispatch. Because `EventSource` reconnects automatically on network drop, the hook only needs to manage the subscription lifecycle and pipe events into the Redux store. The implementation below supports named event types so components can subscribe to specific server event streams without parsing raw message envelopes.

```typescript
// src/hooks/useSSE.ts
import { useEffect, useRef, useState, useCallback } from 'react';

interface SSEEvent {
  type: string;
  data: unknown;
}

interface UseSSEOptions {
  url: string;
  channels?: string[];
  onMessage?: (event: SSEEvent) => void;
  onOpen?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  reconnectInterval?: number;
}

export function useSSE(options: UseSSEOptions) {
  const {
    url,
    channels = [],
    onMessage,
    onOpen,
    onError,
    reconnect = true,
    reconnectInterval = 3000,
  } = options;

  const eventSource = useRef<EventSource | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);

  const connect = useCallback(() => {
    if (eventSource.current) {
      return;
    }

    // Build URL with channels
    const channelParams = channels.map((c) => `channel=${encodeURIComponent(c)}`).join('&');
    const token = localStorage.getItem('access_token');
    const fullUrl = `${url}?${channelParams}&token=${token}`;

    eventSource.current = new EventSource(fullUrl);

    eventSource.current.onopen = () => {
      setIsConnected(true);
      onOpen?.();
    };

    eventSource.current.onerror = (error) => {
      setIsConnected(false);
      onError?.(error);

      if (reconnect) {
        eventSource.current?.close();
        eventSource.current = null;
        setTimeout(connect, reconnectInterval);
      }
    };

    // Handle generic messages
    eventSource.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const sseEvent: SSEEvent = { type: 'message', data };
        setLastEvent(sseEvent);
        onMessage?.(sseEvent);
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };

    // Handle typed events
    eventSource.current.addEventListener('connected', (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      console.log('SSE connected:', data.client_id);
    });
  }, [url, channels, onMessage, onOpen, onError, reconnect, reconnectInterval]);

  const disconnect = useCallback(() => {
    if (eventSource.current) {
      eventSource.current.close();
      eventSource.current = null;
      setIsConnected(false);
    }
  }, []);

  const addEventListener = useCallback((type: string, handler: (event: SSEEvent) => void) => {
    if (eventSource.current) {
      eventSource.current.addEventListener(type, (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          handler({ type, data });
        } catch (error) {
          console.error('Failed to parse SSE event:', error);
        }
      });
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    isConnected,
    lastEvent,
    connect,
    disconnect,
    addEventListener,
  };
}
```

### Junior -> FAANG: Bridging the Go-to-TypeScript Contract Gap

The most damaging integration drift between a Go backend and a TypeScript frontend comes from manually mirroring types. A Go struct changes (`snake_case` field renamed, new required field added, field type changed from `string` to `int`) and the TypeScript interface silently falls out of sync. The runtime crash happens in production, not at compile time, because TypeScript's type checker cannot see the Go server's actual response shape.

The `ApiResponse<T>` pattern in this section is the right first step. The second step is to automate the mirroring. Tools like `tygo` (generates TypeScript types from Go structs) or `oapi-codegen` (generates both Go server stubs and TypeScript types from an OpenAPI spec) eliminate the manual sync step. If your team does not yet use code generation, establish the habit of updating the TypeScript interface in the same commit as the Go struct change, and add a comment in both places referencing the other.

The token-in-`localStorage` pattern in the Axios interceptor is a common starting point but fails the XSS test. If any JavaScript on the page (including third-party scripts) can execute `localStorage.getItem('access_token')`, it can exfiltrate the token. For a first job, understand this trade-off and be ready to discuss it in a code review. The alternative (HttpOnly cookies) prevents JavaScript access but requires CORS credentials and same-site cookie configuration on both client and server.

### Senior @ FAANG: API Client Governance and Type Generation at Scale

**Type generation as a platform contract.** At staff level, the TypeScript API client is not written by hand. It is generated from the OpenAPI spec (or GraphQL schema, or Protobuf definitions) that is the authoritative contract between the backend platform and its consumers. The generation pipeline runs in CI and fails if the generated output differs from the checked-in client code. This makes contract drift a build failure rather than a runtime bug. The ADR decision is whether the spec is "backend-first" (backend engineers write the OpenAPI spec and the client is generated from it) or "contract-first" (a separate team owns the spec and both backend and frontend generate from it). Backend-first is simpler for small teams. Contract-first scales better when frontend and backend teams have equal ownership.

**Token refresh and the distributed session problem.** The `baseQueryWithReauth` function in RTK Query retries the original request after refreshing the token. This is correct for a single-tab application. For a multi-tab application, each tab runs its own refresh flow independently. If two tabs both receive 401 simultaneously, they both attempt to refresh the token, and the second refresh invalidates the token issued by the first refresh. The user is logged out unexpectedly. The correct solution is a singleton token refresh manager (implemented in a shared web worker or a `BroadcastChannel` that coordinates across tabs) that ensures only one tab initiates the refresh while others wait for the result.

**RTK Query tag system as a cache invalidation protocol.** The `providesTags` and `invalidatesTags` system in RTK Query implements a publish/subscribe model for client-side cache invalidation. The backend does not participate in this protocol: the client decides which tags to invalidate based on which mutation completed. This creates a coupling between the backend API semantics and the frontend cache design. When a backend engineer adds a new resource that affects the stale state of an existing list, the frontend engineer must also update the `invalidatesTags` declaration. Document this dependency explicitly in the API changelog, not just in the PR description.

**WebSocket hook stability under React StrictMode.** In React 18 StrictMode, `useEffect` fires twice in development: mount, unmount, mount again. The WebSocket hook's `useEffect` calls `connect()` then `disconnect()` then `connect()` again. If `disconnect()` does not cleanly clean up the `ws.current` reference before the second `connect()` call, you get two active WebSocket connections in development and confusing duplicate messages. Fix by checking `ws.current` for null in both `connect` and `disconnect` and resetting it to null in `disconnect`. StrictMode behavior does not appear in production builds, so this bug is invisible unless you test with StrictMode enabled, which is the default in Create React App and Vite React templates.

**Observability from the frontend client.** A Go backend can log its own errors. It cannot log the errors that happen on the client side: network timeouts, JSON parse failures, token refresh races, EventSource errors. Instrument the `apiClient` wrapper to report errors to a frontend observability service (Sentry, Datadog RUM, or a custom `/api/client-errors` endpoint). Include the request URL, the HTTP status, the error code from the response envelope, and the user's `sessionId` for correlation with backend traces. Without this, debugging production API client issues is guesswork.

---
