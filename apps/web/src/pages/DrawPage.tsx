import { AppBar } from '../components/AppBar'
import { CanvasStage } from '../components/CanvasStage'
import { DockResizer, ReferenceDock } from '../components/ReferenceDock'
import { ToolRail } from '../components/ToolRail'
import { RestoreDialog, WorkspaceDialogs } from '../components/WorkspaceDialogs'
import { useWorkspaceLifecycle } from '../services/useWorkspaceLifecycle'
import { useUiStore } from '../state/uiStore'

export default function DrawPage() {
  const dockWidth = useUiStore((state) => state.dockWidth)
  const dockCollapsed = useUiStore((state) => state.dockCollapsed)
  const lifecycle = useWorkspaceLifecycle()
  return (
    <div className="draw-app" style={{ '--dock-width': `${dockCollapsed ? 44 : dockWidth}px` } as React.CSSProperties}>
      <AppBar saveState={lifecycle.saveState} />
      <ToolRail />
      <main className="drawing-workspace">
        <CanvasStage />
        {!dockCollapsed ? <DockResizer /> : null}
        <ReferenceDock />
      </main>
      <WorkspaceDialogs />
      <RestoreDialog document={lifecycle.restoreCandidate} onRestore={lifecycle.restore} onDiscard={lifecycle.discard} />
      <div className="phone-blocker">
        <span className="wordmark">drawable</span>
        <h1>A larger workspace is needed</h1>
        <p>Open drawable on a tablet or desktop with at least 768 pixels of width.</p>
      </div>
    </div>
  )
}
