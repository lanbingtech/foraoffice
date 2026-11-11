import { Fragment } from 'react'
import { ActionMenu } from './ActionMenu'
import type { DocsRibbonControl, DocsRibbonGroup, DocsRibbonMenuItem } from '../sdk/ribbon'

interface Interaction {
  openMenuId: string | null
  onOpenMenu(id: string | null): void
  onInvoke(id: string): void
}

export const ribbonItemVisible = (item: DocsRibbonControl | DocsRibbonMenuItem): boolean =>
  item.visible !== false && (!('items' in item) || item.items.some(ribbonItemVisible))

function Control({
  item,
  quick = false,
  disabled = false,
  ...interaction
}: Interaction & {
  item: DocsRibbonControl
  quick?: boolean
  disabled?: boolean
}) {
  if (!ribbonItemVisible(item)) return null
  const buttonClass = quick ? 'qa-btn' : 'rb-big'
  const icon = item.icon ? (
    <img src={item.icon} alt="" draggable={false} />
  ) : (
    <span aria-hidden="true">{item.label.slice(0, 1)}</span>
  )
  const content = (
    <>
      <span className={quick ? 'ribbon-extension-icon' : 'rb-big-icon'}>
        {icon}
        {item.type === 'menu' && (
          <span className="ribbon-extension-caret" aria-hidden="true">
            ▾
          </span>
        )}
      </span>
      {!quick && <span>{item.label}</span>}
    </>
  )
  const unavailable = disabled || item.enabled === false
  if (item.type === 'menu')
    return (
      <ActionMenu
        label={item.label}
        items={item.items}
        open={!unavailable && interaction.openMenuId === item.id}
        onOpenChange={(open) => interaction.onOpenMenu(open ? item.id : null)}
        onInvoke={interaction.onInvoke}
        commandLabel={() => ''}
        canExecute={() => false}
        buttonClassName={buttonClass}
        buttonContent={content}
        className="ribbon-extension-menu"
        tooltip={item.tooltip ?? item.label}
        disabled={unavailable}
      />
    )
  return (
    <button
      type="button"
      className={buttonClass}
      aria-label={item.label}
      data-tip={item.tooltip ?? item.label}
      disabled={unavailable}
      onClick={() => {
        interaction.onOpenMenu(null)
        interaction.onInvoke(item.id)
      }}
    >
      {content}
    </button>
  )
}

export function RibbonExtensionGroups({
  groups,
  disabled = false,
  ...interaction
}: Interaction & {
  groups: readonly DocsRibbonGroup[]
  disabled?: boolean
}) {
  return (
    <>
      {groups
        .filter((group) => group.visible !== false && group.items.some(ribbonItemVisible))
        .map((group) => (
          <Fragment key={group.id}>
            <div className="ribbon-sep" />
            <div
              className="ribbon-group"
              role="group"
              aria-label={group.label}
              data-ribbon-extension={group.id}
            >
              <div className="ribbon-group-items">
                {group.items.map((item) => (
                  <Control
                    key={item.id}
                    item={item}
                    disabled={disabled || group.enabled === false}
                    {...interaction}
                  />
                ))}
              </div>
              <div className="ribbon-group-label">{group.label}</div>
            </div>
          </Fragment>
        ))}
    </>
  )
}

export function RibbonQuickAccess({
  items,
  ...interaction
}: Interaction & { items: readonly DocsRibbonControl[] }) {
  return (
    <>
      {items.map((item) => (
        <Control key={item.id} item={item} quick {...interaction} />
      ))}
    </>
  )
}
