## 55.7 React Frontend with Real-Time Updates

### WebSocket Hook

Encapsulating WebSocket lifecycle (connecting, reconnecting on drop, dispatching incoming messages to the Redux store) in a custom hook keeps component trees free of imperative connection management. The hook below uses a `useRef` to hold the socket instance across renders, an exponential backoff timer for reconnection, and a `useEffect` cleanup to close the connection when the component unmounts.

```typescript
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useState } from 'react';

interface WebSocketMessage {
  type: string;
  channel?: string;
  payload?: unknown;
  timestamp: string;
}

interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  reconnectAttempts?: number;
  reconnectInterval?: number;
}

export function useWebSocket({
  url,
  onMessage,
  onConnect,
  onDisconnect,
  reconnectAttempts = 5,
  reconnectInterval = 3000,
}: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);
        reconnectCountRef.current = 0;
        onConnect?.();
      };

      ws.onclose = () => {
        setIsConnected(false);
        onDisconnect?.();

        // Attempt reconnection
        if (reconnectCountRef.current < reconnectAttempts) {
          reconnectCountRef.current++;
          setTimeout(connect, reconnectInterval);
        }
      };

      ws.onerror = () => {
        setError('WebSocket connection error');
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          onMessage?.(message);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };

      wsRef.current = ws;
    } catch (e) {
      setError('Failed to create WebSocket connection');
    }
  }, [url, onMessage, onConnect, onDisconnect, reconnectAttempts, reconnectInterval]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const send = useCallback((message: WebSocketMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const subscribe = useCallback((channel: string) => {
    send({ type: 'subscribe', channel, timestamp: new Date().toISOString() });
  }, [send]);

  const unsubscribe = useCallback((channel: string) => {
    send({ type: 'unsubscribe', channel, timestamp: new Date().toISOString() });
  }, [send]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    isConnected,
    error,
    send,
    subscribe,
    unsubscribe,
    disconnect,
    reconnect: connect,
  };
}
```

### Dashboard Component

The dashboard component subscribes to the WebSocket hook and renders incoming metric series using a charting library that supports streaming data without full re-renders. Memoizing individual chart components with `React.memo` and using virtualization for long metric lists prevents the entire dashboard from re-rendering on every tick. The component below also implements a connection-status indicator so users know immediately when the real-time feed is interrupted.

```typescript
// frontend/src/components/Dashboard/Dashboard.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { LineChart } from '../Charts/LineChart';
import { KPICard } from '../Widgets/KPICard';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { addDataPoint, selectMetrics } from '../../store/slices/metricsSlice';

interface MetricsPayload {
  name: string;
  value: number;
  timestamp: string;
  tags: Record<string, string>;
}

export const Dashboard: React.FC = () => {
  const dispatch = useAppDispatch();
  const metrics = useAppSelector(selectMetrics);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'error'>('disconnected');

  const handleMessage = useCallback((message: { type: string; payload?: unknown }) => {
    if (message.type === 'metrics' && message.payload) {
      const payload = message.payload as MetricsPayload;
      dispatch(addDataPoint({
        metricName: payload.name,
        value: payload.value,
        timestamp: payload.timestamp,
      }));
    }
  }, [dispatch]);

  const { isConnected, subscribe, error } = useWebSocket({
    url: `${import.meta.env.VITE_WS_URL}/ws`,
    onMessage: handleMessage,
    onConnect: () => setConnectionStatus('connected'),
    onDisconnect: () => setConnectionStatus('disconnected'),
  });

  useEffect(() => {
    if (isConnected) {
      // Subscribe to metrics channels
      subscribe('metrics:cpu');
      subscribe('metrics:memory');
      subscribe('metrics:requests');
      subscribe('metrics:latency');
    }
  }, [isConnected, subscribe]);

  useEffect(() => {
    if (error) {
      setConnectionStatus('error');
    }
  }, [error]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Real-Time Metrics Dashboard</h1>
        <div className={`connection-status ${connectionStatus}`}>
          {connectionStatus === 'connected' ? '● Connected' :
           connectionStatus === 'error' ? '● Error' : '○ Disconnected'}
        </div>
      </header>

      <div className="kpi-row">
        <KPICard
          title="CPU Usage"
          value={metrics.cpu.current}
          unit="%"
          trend={metrics.cpu.trend}
        />
        <KPICard
          title="Memory Usage"
          value={metrics.memory.current}
          unit="%"
          trend={metrics.memory.trend}
        />
        <KPICard
          title="Requests/sec"
          value={metrics.requests.current}
          unit=""
          trend={metrics.requests.trend}
        />
        <KPICard
          title="P99 Latency"
          value={metrics.latency.p99}
          unit="ms"
          trend={metrics.latency.trend}
        />
      </div>

      <div className="charts-grid">
        <div className="chart-container">
          <h3>CPU & Memory Over Time</h3>
          <LineChart
            data={[
              { name: 'CPU', data: metrics.cpu.history },
              { name: 'Memory', data: metrics.memory.history },
            ]}
            xAxis="timestamp"
            yAxis="value"
          />
        </div>
        <div className="chart-container">
          <h3>Request Rate</h3>
          <LineChart
            data={[{ name: 'Requests', data: metrics.requests.history }]}
            xAxis="timestamp"
            yAxis="value"
          />
        </div>
        <div className="chart-container">
          <h3>Latency Distribution</h3>
          <LineChart
            data={[
              { name: 'P50', data: metrics.latency.p50History },
              { name: 'P95', data: metrics.latency.p95History },
              { name: 'P99', data: metrics.latency.p99History },
            ]}
            xAxis="timestamp"
            yAxis="value"
          />
        </div>
      </div>
    </div>
  );
};
```

### Redux Store for Metrics

Storing streaming metric data in Redux requires a bounded circular buffer per series rather than an ever-growing array, to prevent the tab from running out of memory after hours of operation. RTK Query handles the initial historical data load with caching and automatic refresh, while a separate WebSocket slice appends live ticks to the ring buffers. The store configuration below defines both slices and establishes the size limits that cap per-series memory consumption.

```typescript
// frontend/src/store/slices/metricsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';

interface DataPoint {
  timestamp: string;
  value: number;
}

interface MetricState {
  current: number;
  trend: 'up' | 'down' | 'stable';
  history: DataPoint[];
}

interface LatencyState extends MetricState {
  p50: number;
  p95: number;
  p99: number;
  p50History: DataPoint[];
  p95History: DataPoint[];
  p99History: DataPoint[];
}

interface MetricsState {
  cpu: MetricState;
  memory: MetricState;
  requests: MetricState;
  latency: LatencyState;
}

const MAX_HISTORY_POINTS = 100;

const initialMetricState: MetricState = {
  current: 0,
  trend: 'stable',
  history: [],
};

const initialState: MetricsState = {
  cpu: { ...initialMetricState },
  memory: { ...initialMetricState },
  requests: { ...initialMetricState },
  latency: {
    ...initialMetricState,
    p50: 0,
    p95: 0,
    p99: 0,
    p50History: [],
    p95History: [],
    p99History: [],
  },
};

function calculateTrend(history: DataPoint[]): 'up' | 'down' | 'stable' {
  if (history.length < 2) return 'stable';
  const recent = history.slice(-5);
  const first = recent[0].value;
  const last = recent[recent.length - 1].value;
  const change = (last - first) / first;
  if (change > 0.05) return 'up';
  if (change < -0.05) return 'down';
  return 'stable';
}

function addToHistory(history: DataPoint[], point: DataPoint): DataPoint[] {
  const newHistory = [...history, point];
  if (newHistory.length > MAX_HISTORY_POINTS) {
    return newHistory.slice(-MAX_HISTORY_POINTS);
  }
  return newHistory;
}

export const metricsSlice = createSlice({
  name: 'metrics',
  initialState,
  reducers: {
    addDataPoint: (state, action: PayloadAction<{
      metricName: string;
      value: number;
      timestamp: string;
      percentile?: string;
    }>) => {
      const { metricName, value, timestamp, percentile } = action.payload;
      const point = { timestamp, value };

      switch (metricName) {
        case 'cpu':
          state.cpu.current = value;
          state.cpu.history = addToHistory(state.cpu.history, point);
          state.cpu.trend = calculateTrend(state.cpu.history);
          break;
        case 'memory':
          state.memory.current = value;
          state.memory.history = addToHistory(state.memory.history, point);
          state.memory.trend = calculateTrend(state.memory.history);
          break;
        case 'requests':
          state.requests.current = value;
          state.requests.history = addToHistory(state.requests.history, point);
          state.requests.trend = calculateTrend(state.requests.history);
          break;
        case 'latency':
          if (percentile === 'p50') {
            state.latency.p50 = value;
            state.latency.p50History = addToHistory(state.latency.p50History, point);
          } else if (percentile === 'p95') {
            state.latency.p95 = value;
            state.latency.p95History = addToHistory(state.latency.p95History, point);
          } else if (percentile === 'p99') {
            state.latency.p99 = value;
            state.latency.p99History = addToHistory(state.latency.p99History, point);
          }
          state.latency.current = state.latency.p99;
          state.latency.trend = calculateTrend(state.latency.p99History);
          break;
      }
    },
    clearMetrics: (state) => {
      Object.assign(state, initialState);
    },
  },
});

export const { addDataPoint, clearMetrics } = metricsSlice.actions;

export const selectMetrics = (state: RootState) => state.metrics;

export default metricsSlice.reducer;
```

---

### Junior -> FAANG: Frontend Real-Time Patterns You Need to Understand

Three patterns in this section appear repeatedly in frontend-adjacent system design interviews: exponential backoff reconnection, circular buffer state management, and the separation of connection logic from rendering logic.

The `useWebSocket` hook keeps WebSocket state out of the component tree. This is important because WebSocket connections have a lifecycle that is independent of component renders. If you put the WebSocket object directly in a component's state, a re-render could close and reopen the connection. The `useRef` holds the connection across renders without triggering re-renders.

For reconnection: the current implementation has a linear retry interval (`reconnectInterval` is fixed). In production, exponential backoff with jitter is the standard because it prevents a thundering herd of reconnecting clients all hitting the server at the same second after a restart. The formula is `delay = min(base * 2^attempt, maxDelay) + random(0, jitter)`. Be able to write this from memory.

The `MAX_HISTORY_POINTS = 100` constant is the circular buffer size. If you remove this limit and let history grow unbounded, the tab will consume gigabytes of memory after hours of operation. The `addToHistory` function enforces this bound by slicing the oldest elements off when the array exceeds the limit. This is not a true circular buffer (it allocates a new slice on each add), but it is simple and correct for 100-element histories. For larger histories, a proper ring buffer preallocates a fixed array and uses head/tail indices.

Interview tip: if asked "how would you prevent a real-time dashboard from consuming unbounded memory on the client side?", the answer is bounded circular buffers per metric series, with a configurable retention window. Name the tradeoff: shorter retention uses less memory but limits how far back users can scroll in the chart.

### Senior @ FAANG: Frontend Architecture Decisions at Organizational Scale

The hook and Redux slice here represent one team's frontend architecture. At a FAANG-scale platform, the frontend architecture becomes a shared concern with different tradeoffs.

**WebSocket vs SSE for the browser layer:** The frontend implementation uses WebSocket. An alternative for read-only dashboards is Server-Sent Events (SSE), which works over HTTP/1.1 and HTTP/2, is automatically supported by the browser's `EventSource` API with built-in reconnection, and does not require protocol upgrade. SSE is simpler to proxy through load balancers (no `Connection: Upgrade` header gymnastics), and HTTP/2 multiplexes multiple SSE streams over one connection. The tradeoff is unidirectionality: SSE cannot send messages from the client to the server, so subscriptions must use a REST call. For a dashboard that only receives data and never sends, SSE is the better choice. A staff engineer writes this comparison in an ADR, not in a Slack thread.

**Redux for real-time data: the right tool?** RTK's Immer-based reducer creates a new immutable copy of state on every action. For `addDataPoint` firing 10 times per second across 20 metric series, that is 200 immutable state updates per second. React's reconciler is efficient, but 200 Redux dispatches per second with 200 selector evaluations is measurable CPU overhead on a low-end device. An alternative is to use `useRef` for the raw time-series data and only update React state at the display refresh rate (60 Hz), decoupling the ingestion rate from the render rate. This is a premature optimization for 10 metrics, but it becomes necessary at 200+ metrics or on mobile devices. A staff engineer defines the threshold at which this optimization is required and adds it to the team's performance budget policy.

**State hydration on reconnect:** The current `useWebSocket` hook reconnects but does not request historical data to fill the gap during the disconnection period. For an operational dashboard, a gap in the chart is confusing. The reconnect handler should request the last N seconds of history via a REST endpoint (`GET /api/metrics?from=lastSeenTimestamp`) and merge it into the Redux store before resuming WebSocket updates. The merge must handle out-of-order delivery (WebSocket updates may arrive before the REST response) and deduplication. This is a non-trivial correctness problem that a staff engineer must specify precisely before implementation.

**Performance budget and Core Web Vitals:** At FAANG, frontend performance is tracked as part of the release process. A real-time dashboard has an unusual profile: it is heavily JavaScript-driven and updates continuously, which means Interaction to Next Paint (INP) is the most important Core Web Vital. A dashboard that re-renders 200 times per second on the main thread will have poor INP. The mitigation is to offload time-series data processing to a Web Worker, keeping the main thread free for user interactions. This is a staff-level architectural decision that affects how the Redux store is structured and where the `addDataPoint` action is dispatched.
