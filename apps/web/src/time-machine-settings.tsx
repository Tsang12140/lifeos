import { useState } from "react";
import { ChevronDown, History } from "lucide-react";
import { TimeMachine } from "./TimeMachine";

export function TimeMachineSettings() {
  const [open, setOpen] = useState(false);
  return <details className="settings-backup-details settings-timemachine" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><History size={15} aria-hidden="true" /><span>时光机</span><ChevronDown size={15} aria-hidden="true" /></summary>
    {open ? <TimeMachine /> : null}
  </details>;
}
