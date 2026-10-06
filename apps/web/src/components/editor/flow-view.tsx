import { describeStep } from '@stepforge/core';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { groupOf, LAYER } from '@/lib/steps';
import type { DraftStep } from './drafts';

type StepNodeData = { step: DraftStep; number: string; branch?: string };

function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const L = LAYER[groupOf(data.step.type)];
  return (
    <div
      className="w-64 rounded-lg border bg-surface px-3 py-2 text-left shadow-sm"
      style={{
        borderColor: `${L.color}88`,
        boxShadow: `inset 3px 0 0 ${L.color}`,
        opacity: data.step.enabled ? 1 : 0.5,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div
        className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase"
        style={{ color: L.color }}
      >
        <L.icon className="h-3 w-3" /> {L.label} · {data.number}
        {data.branch && <span className="ml-auto text-muted normal-case">{data.branch}</span>}
      </div>
      <div className="mt-0.5 line-clamp-2 text-xs text-fg">{data.step.label || describeStep(data.step)}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  );
}

const nodeTypes = { step: StepNode };
const COL = 300;
const ROW = 92;

/** Scenario as a node graph: steps flow top to bottom, nested branches fan out to the right. */
export function FlowView({
  steps,
  onSelect,
}: {
  steps: DraftStep[];
  onSelect: (topLevelKey: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node<StepNodeData>[] = [];
    const edges: Edge[] = [];
    let row = 0;
    const walk = (
      list: DraftStep[],
      prefix: string,
      col: number,
      prevId: string | null,
      topKey: string | null,
      branch?: string,
    ): string | null => {
      let prev = prevId;
      list.forEach((s, i) => {
        const number = prefix ? `${prefix}.${i + 1}` : String(i + 1);
        const id = `${s._k}`;
        nodes.push({
          id,
          type: 'step',
          position: { x: col * COL, y: row++ * ROW },
          data: { step: s, number, branch: i === 0 ? branch : undefined },
        });
        if (prev)
          edges.push({
            id: `${prev}-${id}`,
            source: prev,
            target: id,
            animated: s.type.startsWith('util.') && !!branch,
          });
        const owner = topKey ?? s._k;
        (nodes[nodes.length - 1] as Node<StepNodeData> & { owner?: string }).owner = owner;
        const then = Array.isArray(s.params.steps) ? (s.params.steps as DraftStep[]) : [];
        const otherwise = Array.isArray(s.params.else) ? (s.params.else as DraftStep[]) : [];
        if (then.length) walk(then, number, col + 1, id, owner, s.type === 'util.loop' ? 'repeat' : 'then');
        if (otherwise.length) walk(otherwise, `${number}e`, col + 2, id, owner, 'else');
        prev = id;
      });
      return prev;
    };
    walk(steps, '', 0, null, null);
    return { nodes, edges };
  }, [steps]);

  if (!steps.length) return <p className="py-10 text-center text-sm text-muted">No steps to show.</p>;
  return (
    <div className="h-[560px] overflow-hidden rounded-lg border border-border bg-bg" data-testid="flow-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: 0.8 }}
        minZoom={0.3}
        panOnScroll
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_e, n) => onSelect((n as Node & { owner?: string }).owner ?? n.id)}
        proOptions={{ hideAttribution: true }}
        colorMode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
