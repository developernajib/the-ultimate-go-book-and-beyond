## 54.6 Real-Time Updates

### WebSocket Hook

Encapsulating WebSocket lifecycle in a custom hook keeps component trees free of imperative connection management. The hook uses a `useRef` to hold the socket instance across renders, a timeout for reconnection after disconnects, and a `useEffect` cleanup to close the connection when the component unmounts. Incoming messages are dispatched as RTK Query cache invalidations so the board refetches only the affected data.

```typescript
// frontend/src/hooks/useProjectWebSocket.ts
import { useEffect, useCallback, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { taskApi } from '../store/api/taskApi';

interface WebSocketMessage {
  type: string;
  payload: unknown;
}

export function useProjectWebSocket(projectId: string) {
  const { token } = useSelector((state: RootState) => state.auth);
  const dispatch = useDispatch();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();

  const connect = useCallback(() => {
    if (!token || !projectId) return;

    const wsUrl = `${import.meta.env.VITE_WS_URL || 'ws://localhost:8080'}/api/v1/ws?token=${token}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      // Join project room
      ws.send(JSON.stringify({
        type: 'join',
        payload: { room: `project:${projectId}` },
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [token, projectId]);

  const handleMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'task_created':
      case 'task_updated':
      case 'task_moved':
      case 'task_reordered':
      case 'task_deleted':
        // Invalidate task cache to trigger refetch
        dispatch(
          taskApi.util.invalidateTags([{ type: 'Task', id: projectId }])
        );
        break;

      case 'comment_added':
        // Handle comment added
        const { task_id } = message.payload as { task_id: string };
        dispatch(
          taskApi.util.invalidateTags([{ type: 'Task', id: task_id }])
        );
        break;

      case 'user_active':
        // Handle presence update
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }, [dispatch, projectId]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const sendMessage = useCallback((type: string, payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { sendMessage };
}
```

### Project Page with WebSocket

The project page connects the WebSocket hook to the Kanban board so remote task changes appear in real time without a page refresh. The `useProjectWebSocket` hook subscribes to the current project's room on mount and invalidates the RTK Query cache when server events arrive, triggering a refetch that updates the board.

```typescript
// frontend/src/pages/ProjectPage.tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useGetProjectQuery } from '../store/api/projectApi';
import { useGetTasksQuery, Task } from '../store/api/taskApi';
import { useProjectWebSocket } from '../hooks/useProjectWebSocket';

import KanbanBoard from '../components/KanbanBoard';
import TaskModal from '../components/TaskModal';
import CreateTaskModal from '../components/CreateTaskModal';
import LoadingSpinner from '../components/LoadingSpinner';

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Connect to WebSocket for real-time updates
  useProjectWebSocket(projectId!);

  const { data: project, isLoading: projectLoading } = useGetProjectQuery(projectId!);
  const { data: tasks, isLoading: tasksLoading } = useGetTasksQuery(projectId!);

  if (projectLoading || tasksLoading) {
    return <LoadingSpinner />;
  }

  if (!project || !tasks) {
    return <div>Project not found</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">{project.name}</h1>
          {project.description && (
            <p className="text-gray-500 mt-1">{project.description}</p>
          )}
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          Create Task
        </button>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 overflow-hidden">
        <KanbanBoard
          projectId={projectId!}
          tasks={tasks}
          onTaskClick={setSelectedTask}
        />
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          projectId={projectId!}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
```

### Junior -> FAANG: WebSocket Hook Patterns in Interviews

Custom hooks that manage side effects are a common React interview topic. The `useProjectWebSocket` hook demonstrates the canonical pattern: `useRef` for the mutable socket instance (not `useState`, because changing the ref does not trigger a re-render), `useCallback` to stabilize the `connect` function across renders, and `useEffect` cleanup to close the socket when the component unmounts.

The interview question you will face: "What happens if `projectId` changes while the hook is mounted?" The current implementation depends on `connect` being stable. If `projectId` changes, `connect` changes (it is in the dependency array), `disconnect` is called by the cleanup, and `connect` runs again with the new project ID. That is correct behavior. Practice tracing through the `useEffect` dependency chain out loud.

Know what happens when you forget the cleanup function. The socket stays open, sends events, and tries to update unmounted components. React will log a warning about updating state after unmount. In production, this causes memory leaks because the closed component's closure keeps the WebSocket reference alive.

### Senior @ FAANG: Real-Time Architecture Tradeoffs at Scale

The hook's reconnect strategy is a flat 3-second delay. In a system with many clients (10,000 concurrent users), a server restart causes a thundering herd: all clients attempt to reconnect simultaneously 3 seconds after the outage. The correct pattern is exponential backoff with jitter: `delay = Math.min(baseDelay * 2^attempt + random(0, 1000ms), maxDelay)`. This spreads reconnection attempts across a window of time and prevents the server from being overwhelmed at restart.

**Cache invalidation vs. cache patching.** The hook invalidates the entire project tag on every task event, causing a full board refetch. At 200 tasks, this is a 200-row query per event per client. If 50 users are watching the same board and someone creates a task, that is 50 full board refetches triggered simultaneously. The correct approach for production is surgical cache patching using `taskApi.util.updateQueryData`: when a `task_created` event arrives, append the new task to the correct column in the cached board without a round trip. This requires the WebSocket event to carry the full task payload, which means your event schema is a public API contract that cannot be changed without a versioning strategy.

**Event ordering and idempotency.** The hook processes events in the order they arrive. If the WebSocket connection drops and reconnects, events that arrived during the gap are lost. The file on common mistakes discusses a ring-buffer resume mechanism on the server. The client-side complement is a sequence number on each event: the client tracks the last received sequence number and sends it on reconnect, and the server replays from that point. Without this, reconnection gives users a stale board that silently differs from the server state until they manually refresh.

**Presence as a first-class feature.** The `user_active` message is handled with a comment ("Handle presence update") and no implementation. At FAANG, presence is a product feature with measurable engagement impact. The correct implementation: track active users per room in Redis with a short TTL (30 seconds, renewed by heartbeat), expose a presence API, and render presence indicators on the board header. The WebSocket hook's `sendMessage` function should emit a `presence` heartbeat on an interval (every 20 seconds) so the server can maintain accurate presence data. Teams that ship presence indicators see reduced duplicate work on shared tasks.

---
