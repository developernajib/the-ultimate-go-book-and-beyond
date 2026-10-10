## 54.5 Kanban Board Component

The Kanban board renders tasks grouped by status column and supports drag-and-drop reordering within and between columns. The `@dnd-kit` library provides fine-grained control over drag sensors and collision detection strategy. The component maintains a `localTasks` copy of the prop data so it can apply optimistic reordering instantly in the UI while the backend confirms the new position asynchronously. If the server rejects the move, the state reverts to the original prop value.

```typescript
// frontend/src/components/KanbanBoard.tsx
import React, { useState, useCallback } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

import { Task, useUpdateTaskPositionMutation } from '../store/api/taskApi';
import KanbanColumn from './KanbanColumn';
import TaskCard from './TaskCard';

interface KanbanBoardProps {
  projectId: string;
  tasks: {
    todo: Task[];
    in_progress: Task[];
    review: Task[];
    done: Task[];
  };
  onTaskClick: (task: Task) => void;
}

const COLUMNS = [
  { id: 'todo', title: 'To Do', color: 'bg-gray-100' },
  { id: 'in_progress', title: 'In Progress', color: 'bg-blue-100' },
  { id: 'review', title: 'Review', color: 'bg-yellow-100' },
  { id: 'done', title: 'Done', color: 'bg-green-100' },
];

export default function KanbanBoard({ projectId, tasks, onTaskClick }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [localTasks, setLocalTasks] = useState(tasks);
  const [updatePosition] = useUpdateTaskPositionMutation();

  // Update local state when tasks prop changes
  React.useEffect(() => {
    setLocalTasks(tasks);
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const task = findTask(active.id as string, localTasks);
    setActiveTask(task || null);
  }, [localTasks]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = findColumn(activeId, localTasks);
    const overColumn = over.data.current?.sortable?.containerId || findColumn(overId, localTasks) || overId;

    if (!activeColumn || !overColumn || activeColumn === overColumn) return;

    setLocalTasks((prev) => {
      const activeTask = prev[activeColumn as keyof typeof prev].find((t) => t.id === activeId);
      if (!activeTask) return prev;

      return {
        ...prev,
        [activeColumn]: prev[activeColumn as keyof typeof prev].filter((t) => t.id !== activeId),
        [overColumn]: [...prev[overColumn as keyof typeof prev], { ...activeTask, status: overColumn }],
      };
    });
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = findColumn(activeId, localTasks);
    let overColumn = over.data.current?.sortable?.containerId || findColumn(overId, localTasks);

    // If dropping on a column header, use that column
    if (COLUMNS.some((c) => c.id === overId)) {
      overColumn = overId;
    }

    if (!activeColumn || !overColumn) return;

    const columnTasks = localTasks[overColumn as keyof typeof localTasks];
    let newIndex = columnTasks.findIndex((t) => t.id === overId);

    if (newIndex === -1) {
      newIndex = columnTasks.length;
    }

    // If same column, reorder
    if (activeColumn === overColumn) {
      const oldIndex = columnTasks.findIndex((t) => t.id === activeId);
      if (oldIndex !== newIndex) {
        setLocalTasks((prev) => ({
          ...prev,
          [overColumn]: arrayMove(prev[overColumn as keyof typeof prev], oldIndex, newIndex),
        }));
      }
    }

    // Update server
    try {
      await updatePosition({
        taskId: activeId,
        data: {
          status: overColumn,
          position: newIndex,
        },
      }).unwrap();
    } catch (error) {
      // Revert on error
      setLocalTasks(tasks);
    }
  }, [localTasks, tasks, updatePosition]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 h-full overflow-x-auto p-4">
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column.id}
            id={column.id}
            title={column.title}
            color={column.color}
            tasks={localTasks[column.id as keyof typeof localTasks]}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask && (
          <TaskCard task={activeTask} isDragging />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function findTask(id: string, tasks: KanbanBoardProps['tasks']): Task | undefined {
  for (const column of Object.values(tasks)) {
    const task = column.find((t) => t.id === id);
    if (task) return task;
  }
  return undefined;
}

function findColumn(taskId: string, tasks: KanbanBoardProps['tasks']): string | undefined {
  for (const [columnId, columnTasks] of Object.entries(tasks)) {
    if (columnTasks.some((t) => t.id === taskId)) {
      return columnId;
    }
  }
  return undefined;
}
```

Each column renders as a droppable zone that accepts tasks from any other column. The `useDroppable` hook from `@dnd-kit` registers the DOM node as a drop target and provides an `isOver` flag for visual feedback. Inside the column, a `SortableContext` enables vertical reordering of cards within the same status group.

```typescript
// frontend/src/components/KanbanColumn.tsx
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Task } from '../store/api/taskApi';
import SortableTaskCard from './SortableTaskCard';

interface KanbanColumnProps {
  id: string;
  title: string;
  color: string;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export default function KanbanColumn({
  id,
  title,
  color,
  tasks,
  onTaskClick,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex-shrink-0 w-72 ${color} rounded-lg p-3 ${
        isOver ? 'ring-2 ring-blue-400' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-700">{title}</h3>
        <span className="bg-gray-200 text-gray-600 text-sm px-2 py-0.5 rounded-full">
          {tasks.length}
        </span>
      </div>

      <SortableContext
        id={id}
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-2 min-h-[200px]">
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              onClick={() => onTaskClick(task)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
```

The `TaskCard` component renders the visual representation of a single task, displaying its title, priority badge, labels, due date, and assignee avatar. The `isDragging` prop applies a shadow and opacity shift so the user can distinguish the dragged card from the original position's placeholder.

```typescript
// frontend/src/components/TaskCard.tsx
import { Task } from '../store/api/taskApi';
import { CalendarIcon, UserIcon } from '@heroicons/react/24/outline';
import { format } from 'date-fns';

interface TaskCardProps {
  task: Task;
  isDragging?: boolean;
  onClick?: () => void;
}

const PRIORITY_COLORS = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-blue-100 text-blue-600',
  high: 'bg-orange-100 text-orange-600',
  urgent: 'bg-red-100 text-red-600',
};

export default function TaskCard({ task, isDragging, onClick }: TaskCardProps) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-lg shadow-sm p-3 cursor-pointer hover:shadow-md transition-shadow ${
        isDragging ? 'shadow-lg opacity-90' : ''
      }`}
    >
      <h4 className="font-medium text-gray-800 mb-2 line-clamp-2">{task.title}</h4>

      {task.labels && task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.labels.slice(0, 3).map((label, index) => (
            <span
              key={index}
              className="text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded"
            >
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-gray-500">
        <span className={`px-2 py-0.5 rounded text-xs ${PRIORITY_COLORS[task.priority]}`}>
          {task.priority}
        </span>

        <div className="flex items-center gap-2">
          {task.due_date && (
            <span className="flex items-center gap-1">
              <CalendarIcon className="w-4 h-4" />
              {format(new Date(task.due_date), 'MMM d')}
            </span>
          )}

          {task.assignee && (
            <span className="flex items-center gap-1">
              {task.assignee.avatar_url ? (
                <img
                  src={task.assignee.avatar_url}
                  alt={task.assignee.name}
                  className="w-5 h-5 rounded-full"
                />
              ) : (
                <UserIcon className="w-4 h-4" />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

### Junior -> FAANG: Optimistic Updates and Why They Are Interview Topics

FAANG frontend design questions almost always include: "What happens to the UI when a network request fails?" The Kanban board demonstrates the textbook answer: apply the change locally first (`setLocalTasks`), send the request to the server, and revert to the original prop value on failure (`setLocalTasks(tasks)`).

Practice this pattern until it is second nature. The interview follow-up will be: "What if two users drag the same card simultaneously?" Your answer should cover the version-check pattern from the backend section: the server rejects the second move and returns the current state, and the frontend reverts and shows the server's authoritative position. If you cannot connect the frontend optimistic update to the backend version check in the same answer, you are demonstrating frontend knowledge and backend knowledge but not systems thinking.

Know `@dnd-kit` well enough to explain why `PointerSensor` has an `activationConstraint.distance` of 8 pixels. Without it, clicking a card triggers a drag start before the user has moved. This is a usability detail interviewers use to test whether you have actually shipped drag-and-drop.

### Senior @ FAANG: Drag-and-Drop at Collaborative Scale

The `KanbanBoard` component maintains `localTasks` as a copy of the server state. This introduces a synchronization problem: if a WebSocket event arrives while a drag is in progress, the `useEffect` that calls `setLocalTasks(tasks)` will reset the user's in-progress drag to the server state. The fix requires a drag-in-progress flag that suppresses prop-driven state updates. The board should accept incoming WebSocket events, queue them, and apply them only after the drag ends. This is exactly the "lock the entity during drag" pattern described in the pitfalls file.

**Accessibility and the FAANG bar.** The `@dnd-kit` library provides keyboard navigation out of the box if you wire the `KeyboardSensor`. At FAANG, accessibility is not optional. A Kanban board that is only usable with a pointer device fails WCAG 2.1 Level AA at several checkpoints (1.3.1, 2.1.1). A bar-raiser will ask whether the component is keyboard accessible. If the answer is "we used `@dnd-kit` but did not wire the keyboard sensor," the follow-up is "why not?" There is no good answer other than "we missed it."

**Virtualization for large boards.** The current component renders all cards in all columns unconditionally. At 500 tasks per column, this creates 2000 DOM nodes and causes visible jank on card updates. The production solution is column-level virtualization using `@tanstack/react-virtual`. Each column renders only the visible cards plus a small overscan buffer. The complication: virtual lists have fixed item heights by default, but task cards have variable heights. Measure each card once after mount and cache the measurement.

**Fractional index rebalancing and the frontend.** The backend uses fractional indexing (midpoint between two adjacent sort keys) for efficient single-row updates during reorder. After many reorders, the gap between adjacent keys approaches floating-point epsilon and the keys become indistinguishable. The rebalance operation (reassigning clean keys to all rows in the column) should be triggered by the backend and communicated to the frontend as a full column snapshot, not as individual move events. The frontend should treat this snapshot as a cache replacement, not as an incremental update.

---
