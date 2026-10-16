import "./search-alternatives.css";

export function SearchAssistantHint({ onAskAssistant }: { onAskAssistant: () => void }) {
  return <p className="search-assistant-hint">没找到想要的？<button type="button" onClick={onAskAssistant}>试试问 AI 管家</button><span>，记不清细节也可以。</span></p>;
}
