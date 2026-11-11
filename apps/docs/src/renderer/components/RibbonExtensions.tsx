import { Fragment } from 'react'
import { ActionMenu } from './ActionMenu'
import { IconCaret, IconShapes } from './icons'
import { QUICK_ACCESS_ICON_SIZE, RIBBON_ICON_SIZE } from './ribbon-metrics'
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
  const buttonClass = quick ? `qa-btn${item.type === 'menu' ? ' qa-btn-menu' : ''}` : 'rb-big'
  const size = quick ? QUICK_ACCESS_ICON_SIZE : RIBBON_ICON_SIZE
  const icon = item.icon ? (
    <img src={item.icon} alt="" width={size} height={size} draggable={false} />
  ) : (
    <IconShapes size={size} />
  )
  const caret = item.type === 'menu' ? <IconCaret /> : null
  const content = quick ? (
    <>
      {icon}
      {caret}
    </>
  ) : (
    <>
      <span className="rb-big-icon">
        {icon}
        {caret}
      </span>
      <span>{item.label}</span>
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
      className={`${buttonClass}${item.pressed === true ? ' active' : ''}`}
      aria-label={item.label}
      aria-pressed={item.pressed}
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
