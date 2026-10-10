## 54.4 Frontend Architecture

### React App Setup

Vite provides fast hot-module replacement during development and an optimized production build with code splitting. The app shell configures the Redux store provider, React Router, and the authentication wrapper before mounting any feature routes, so feature components can assume auth context and store access are always available.

```typescript
// frontend/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { store } from './store';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Provider>
  </React.StrictMode>
);
```

The `App` component defines the route tree and wraps protected routes in a guard that redirects unauthenticated users to the login page. Nested routes under the `Layout` component share a common sidebar and header, while the `ProtectedRoute` wrapper reads the auth token from Redux state rather than making a network call on every navigation.

```typescript
// frontend/src/App.tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from './store';

import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import ProjectPage from './pages/ProjectPage';
import SettingsPage from './pages/SettingsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useSelector((state: RootState) => state.auth);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="projects/:projectId" element={<ProjectPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
```

### Redux Store Setup

The Redux store is the single source of truth for all client-side state, including auth tokens, cached API responses from RTK Query, and transient UI state like drag-and-drop positions. Configuring the store with RTK Query's API middleware wires up automatic cache invalidation when mutations succeed, keeping the Kanban board in sync without manual refetch calls. The configuration below registers all slices and enables the Redux DevTools extension for development builds.

```typescript
// frontend/src/store/index.ts
import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { apiSlice } from './api/apiSlice';
import authReducer from './slices/authSlice';

export const store = configureStore({
  reducer: {
    [apiSlice.reducerPath]: apiSlice.reducer,
    auth: authReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(apiSlice.middleware),
});

setupListeners(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

The auth slice manages the user session, persisting tokens to `localStorage` so they survive page refreshes. The `setCredentials` action stores both access and refresh tokens after login, while `logout` clears everything. Note that reading from `localStorage` in `initialState` runs synchronously during store creation, so the app can skip the login page if a valid token already exists.

```typescript
// frontend/src/store/slices/authSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
}

const initialState: AuthState = {
  user: null,
  token: localStorage.getItem('access_token'),
  refreshToken: localStorage.getItem('refresh_token'),
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials: (
      state,
      action: PayloadAction<{ user: User; token: string; refreshToken: string }>
    ) => {
      state.user = action.payload.user;
      state.token = action.payload.token;
      state.refreshToken = action.payload.refreshToken;
      localStorage.setItem('access_token', action.payload.token);
      localStorage.setItem('refresh_token', action.payload.refreshToken);
    },
    setToken: (state, action: PayloadAction<string>) => {
      state.token = action.payload;
      localStorage.setItem('access_token', action.payload);
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.refreshToken = null;
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
    },
  },
});

export const { setCredentials, setToken, logout } = authSlice.actions;
export default authSlice.reducer;
```

### Task API Slice

RTK Query's `createApi` generates typed hooks for every endpoint, handling loading states, caching, and cache invalidation declaratively. The task API slice co-locates endpoint definitions with the cache tags they produce and consume, making it clear which mutations invalidate which queries. The `updateTaskPosition` mutation skips automatic invalidation because position changes are handled optimistically on the client side.

```typescript
// frontend/src/store/api/taskApi.ts
import { apiSlice } from './apiSlice';

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description?: string;
  status: 'todo' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  position: number;
  assignee_id?: string;
  creator_id: string;
  due_date?: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  assignee?: {
    id: string;
    name: string;
    avatar_url?: string;
  };
  creator?: {
    id: string;
    name: string;
    avatar_url?: string;
  };
}

export interface TasksResponse {
  todo: Task[];
  in_progress: Task[];
  review: Task[];
  done: Task[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: string;
  assignee_id?: string;
  due_date?: string;
  labels?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: string;
  assignee_id?: string | null;
  due_date?: string | null;
  labels?: string[];
}

export interface UpdatePositionInput {
  status: string;
  position: number;
}

export const taskApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getTasks: builder.query<TasksResponse, string>({
      query: (projectId) => `/projects/${projectId}/tasks`,
      transformResponse: (response: { success: boolean; data: TasksResponse }) => response.data,
      providesTags: (result, error, projectId) => [{ type: 'Task', id: projectId }],
    }),

    getTask: builder.query<Task, string>({
      query: (taskId) => `/tasks/${taskId}`,
      transformResponse: (response: { success: boolean; data: Task }) => response.data,
      providesTags: (result, error, taskId) => [{ type: 'Task', id: taskId }],
    }),

    createTask: builder.mutation<Task, { projectId: string; data: CreateTaskInput }>({
      query: ({ projectId, data }) => ({
        url: `/projects/${projectId}/tasks`,
        method: 'POST',
        body: data,
      }),
      transformResponse: (response: { success: boolean; data: Task }) => response.data,
      invalidatesTags: (result, error, { projectId }) => [{ type: 'Task', id: projectId }],
    }),

    updateTask: builder.mutation<Task, { taskId: string; data: UpdateTaskInput }>({
      query: ({ taskId, data }) => ({
        url: `/tasks/${taskId}`,
        method: 'PUT',
        body: data,
      }),
      transformResponse: (response: { success: boolean; data: Task }) => response.data,
      invalidatesTags: (result) =>
        result ? [{ type: 'Task', id: result.project_id }, { type: 'Task', id: result.id }] : [],
    }),

    updateTaskStatus: builder.mutation<Task, { taskId: string; status: string }>({
      query: ({ taskId, status }) => ({
        url: `/tasks/${taskId}/status`,
        method: 'PATCH',
        body: { status },
      }),
      transformResponse: (response: { success: boolean; data: Task }) => response.data,
      invalidatesTags: (result) =>
        result ? [{ type: 'Task', id: result.project_id }] : [],
    }),

    updateTaskPosition: builder.mutation<Task, { taskId: string; data: UpdatePositionInput }>({
      query: ({ taskId, data }) => ({
        url: `/tasks/${taskId}/position`,
        method: 'PATCH',
        body: data,
      }),
      transformResponse: (response: { success: boolean; data: Task }) => response.data,
      // Don't invalidate - handle optimistically
    }),

    deleteTask: builder.mutation<void, { taskId: string; projectId: string }>({
      query: ({ taskId }) => ({
        url: `/tasks/${taskId}`,
        method: 'DELETE',
      }),
      invalidatesTags: (result, error, { projectId }) => [{ type: 'Task', id: projectId }],
    }),
  }),
});

export const {
  useGetTasksQuery,
  useGetTaskQuery,
  useCreateTaskMutation,
  useUpdateTaskMutation,
  useUpdateTaskStatusMutation,
  useUpdateTaskPositionMutation,
  useDeleteTaskMutation,
} = taskApi;
```

### Junior -> FAANG: State Management Decisions FAANG Tests

FAANG frontend interviews frequently start with: "Why Redux instead of local component state, React Query, or Zustand?" You need a real answer, not "because it's popular." The answer here is that the auth token needs to be accessible from the WebSocket hook, the RTK Query middleware, and the API base query simultaneously. A single Redux store with a typed `RootState` makes that cross-cutting access explicit and testable.

Know the difference between server state (what RTK Query manages: tasks, projects, users fetched from the API) and client state (what Redux slices manage: the current auth session, drag-in-progress status). Mixing the two causes cache invalidation bugs. RTK Query handles server state because it knows when to refetch. Redux handles client state because nothing else does.

Practice explaining `providesTags` and `invalidatesTags` in one minute. The mental model: mutations tell the cache "this tag is now stale." Queries tell the cache "I depend on this tag, refetch me when it is invalidated." If you cannot explain this without looking it up, you will fail the RTK Query coding exercise.

The `localStorage` auth pattern in `authSlice` is the standard approach for SPAs but carries security risk: JavaScript can read `localStorage`, which means XSS can steal tokens. The HttpOnly cookie alternative prevents that but complicates token refresh logic in RTK Query. Know both approaches and when each is appropriate.

### Senior @ FAANG: Frontend Architecture at Platform Scale

The architecture shown here scales to a single-team codebase. At FAANG, you are designing for dozens of teams contributing features to a monorepo SPA. Three governance decisions become critical.

**Module federation and bundle ownership.** When the Kanban board team and the Timeline team both want to ship features independently, the SPA's single build graph becomes a coordination cost. Module Federation (Webpack 5, Vite plugins) lets teams ship independent JavaScript bundles that are composed at runtime. The tradeoff: harder debugging across module boundaries, shared library version negotiation, and increased runtime complexity. The ADR question is: what is the team size threshold at which Federation pays off vs. monorepo coordination? Most FAANG teams cross that threshold at around 6-8 independent feature teams.

**RTK Query cache coherence with WebSocket events.** The WebSocket hook in this chapter invalidates the entire `Task` tag for a project on any task event, triggering a full board refetch. At 1000 tasks per project, that is a 1000-row query on every drag-drop. The production pattern is cache patching: instead of invalidating, the WebSocket message handler uses `dispatch(taskApi.util.updateQueryData(...))` to surgically update the specific task in the cached board response. This requires the WebSocket payload to contain enough data to reconstruct the updated task without a round trip. The design implication: your WebSocket event schema is part of your API contract and must be versioned.

**Type safety across the API boundary.** The TypeScript types in `taskApi.ts` are manually written to match the Go structs. In a team setting, these drift. The correct senior-level setup is shared type generation: the Go backend exposes an OpenAPI spec (using `swaggo/swag` or `kin-openapi`), and the frontend CI step runs `openapi-typescript` to generate types from that spec. Any mismatch is a CI failure, not a runtime error. This is the difference between a proof-of-concept and a maintained platform.

---
