/** Shared pieces of the Settings pages: a row, the back link, the legal URLs. */
import type { ReactNode } from "react";
import { useLinkProps } from "../../router/Router";
import { Icon, type IconName } from "../../ui/Icon";

export const PRIVACY_URL = "https://klorn.ai/privacy/";
export const TERMS_URL = "https://klorn.ai/terms/";

export function SettingsRow({
  icon,
  label,
  value,
  to,
  onClick,
  danger,
  external,
}: {
  icon?: IconName;
  label: string;
  value?: ReactNode;
  to?: Parameters<typeof useLinkProps>[0];
  onClick?: () => void;
  danger?: boolean;
  external?: boolean;
}) {
  const link = useLinkProps(to ?? { name: "settings" });
  const body = (
    <>
      {icon ? <Icon name={icon} size={20} className="set-row__icon" /> : null}
      <span className="set-row__label">{label}</span>
      {value !== undefined ? <span className="set-row__value">{value}</span> : null}
      {to || onClick ? (
        <Icon
          name={external ? "external" : "chevronRight"}
          size={external ? 16 : 14}
          strokeWidth={2.2}
          className="set-row__chevron"
        />
      ) : null}
    </>
  );
  return (
    <li className="set-row" data-danger={danger || undefined}>
      {to ? (
        <a className="set-row__control" {...link}>
          {body}
        </a>
      ) : onClick ? (
        <button type="button" className="set-row__control" onClick={onClick}>
          {body}
        </button>
      ) : (
        <span className="set-row__control">{body}</span>
      )}
    </li>
  );
}

export function SettingsBack({
  to,
  label,
}: {
  to: Parameters<typeof useLinkProps>[0];
  label: string;
}) {
  const link = useLinkProps(to);
  return (
    <a className="detail-back settings__back" {...link}>
      <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
      {label}
    </a>
  );
}
