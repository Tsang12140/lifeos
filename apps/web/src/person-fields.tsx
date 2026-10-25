import type { PersonDetails } from "@lifeos/core";

export function PersonFields({ value, onChange, disabled = false }: { value: PersonDetails; onChange: (patch: Partial<PersonDetails>) => void; disabled?: boolean }) {
  return <div className="person-contact-fields">
    <label className="dialog-field person-contact-field"><span>手机号</span><input type="tel" aria-label="手机号" placeholder="选填" maxLength={200} value={value.phone ?? ""} disabled={disabled} onChange={event => onChange({ phone: event.target.value })} /></label>
    <label className="dialog-field person-contact-field"><span>微信号</span><input aria-label="微信号" placeholder="选填" maxLength={200} value={value.wechat ?? ""} disabled={disabled} onChange={event => onChange({ wechat: event.target.value })} /></label>
    <label className="dialog-field person-contact-field"><span>住址</span><input aria-label="住址" placeholder="选填" maxLength={500} value={value.residence ?? ""} disabled={disabled} onChange={event => onChange({ residence: event.target.value })} /></label>
  </div>;
}
