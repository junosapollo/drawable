import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { X } from 'lucide-react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'small' | 'regular' | 'large'
}

export function IconButton({ label, active, size = 'regular', className = '', children, ...props }: IconButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active === undefined ? undefined : active}
          className={`icon-button icon-button--${size} ${active ? 'is-active' : ''} ${className}`}
          {...props}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export function Button({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`button ${className}`} {...props}>{children}</button>
}

interface AppDialogProps {
  open: boolean
  onOpenChange: (value: boolean) => void
  title: string
  description?: string
  children: ReactNode
}

export function AppDialog({ open, onOpenChange, title, description, children }: AppDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <header className="dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close dialog"><X size={17} /></IconButton>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Field({ label, value, children }: PropsWithChildren<{ label: string; value?: string }>) {
  return (
    <label className="field">
      <span className="field-label"><span>{label}</span>{value ? <output>{value}</output> : null}</span>
      {children}
    </label>
  )
}

export function StatusDot({ tone = 'neutral' }: { tone?: 'neutral' | 'success' | 'warning' | 'error' }) {
  return <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
}
