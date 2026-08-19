import React from 'react';
const { useEffect, useState } = React;


function parseHexColor(color) {
    if (typeof color !== 'string') {
        return null;
    }

    const normalized = color.trim();
    if (!normalized) {
        return null;
    }

    const shortMatch = normalized.match(/^#([0-9a-f]{3})$/i);
    if (shortMatch) {
        const chars = shortMatch[1].split('');
        return {
            r: parseInt(chars[0] + chars[0], 16),
            g: parseInt(chars[1] + chars[1], 16),
            b: parseInt(chars[2] + chars[2], 16)
        };
    }

    const fullMatch = normalized.match(/^#([0-9a-f]{6})$/i);
    if (fullMatch) {
        const hex = fullMatch[1];
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16)
        };
    }

    return null;
}

function buildSectionStyle(color) {
    if (typeof color !== 'string' || !color.trim()) {
        return undefined;
    }

    const normalized = color.trim();
    const rgb = parseHexColor(normalized);
    if (!rgb) {
        return {
            '--section-accent-color': normalized
        };
    }

    return {
        '--section-accent-color': normalized,
        '--section-bg-color': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.10)`,
        '--section-border-color': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.34)`
    };
}

export function Section({
    children,
    className,
    title,
    color,
    collapsable = false,
    collapsedByDefault = false
}) {
    const isCollapsable = Boolean(collapsable);
    const [isCollapsed, setIsCollapsed] = useState(isCollapsable && Boolean(collapsedByDefault));
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const resolvedTitle = hasTitle ? title.trim() : '';

    useEffect(() => {
        setIsCollapsed(Boolean(collapsable) && Boolean(collapsedByDefault));
    }, [collapsable, collapsedByDefault]);

    const sectionClassName = `section${className ? ' ' + className : ''}${isCollapsed ? ' collapsed' : ''}`;
    const sectionStyle = buildSectionStyle(color);
    const toggleLabel = `${isCollapsed ? 'Expand' : 'Collapse'} ${resolvedTitle || 'Section'}`;
    const shouldRenderHeader = hasTitle || isCollapsable;
    const toggleCollapsed = () => {
        if (!isCollapsable) {
            return;
        }
        setIsCollapsed((previous) => !previous);
    };

    const handleHeaderKeyDown = (event) => {
        if (!isCollapsable) {
            return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleCollapsed();
        }
    };

    return (
        <div className={sectionClassName} style={sectionStyle}>
            {shouldRenderHeader ? (
                <div
                    className={`section-header${isCollapsable ? ' collapsable' : ''}`}
                    onClick={isCollapsable ? toggleCollapsed : undefined}
                    onKeyDown={isCollapsable ? handleHeaderKeyDown : undefined}
                    role={isCollapsable ? 'button' : undefined}
                    tabIndex={isCollapsable ? 0 : undefined}
                    title={isCollapsable ? toggleLabel : undefined}
                    aria-label={isCollapsable ? toggleLabel : undefined}
                >
                    {hasTitle ? <h2>{resolvedTitle}</h2> : <span></span>}
                    {isCollapsable ? (
                        <span className={`section-collapse-button${isCollapsed ? ' collapsed' : ''}`} aria-hidden="true">
                            <span className="material-icons">{isCollapsed ? 'expand_more' : 'expand_less'}</span>
                        </span>
                    ) : null}
                </div>
            ) : null}
            {!isCollapsed ? (
                <div className="section-content">
                    {children}
                </div>
            ) : null}
        </div>
    );
}


export function DialogToggleRow({
    label,
    description,
    checked = false,
    onChange,
    className,
    compact = false,
    disabled = false,
    title
}) {
    const hasLabel = typeof label === 'string' && label.trim().length > 0;
    const hasDescription = typeof description === 'string' && description.trim().length > 0;
    const isChecked = Boolean(checked);
    const isDisabled = Boolean(disabled);
    const canToggle = typeof onChange === 'function' && !isDisabled;
    const resolvedLabel = hasLabel ? label.trim() : '';
    const resolvedDescription = hasDescription ? description.trim() : '';

    const rowClassName = [
        'dialog-toggle-row',
        compact ? 'compact' : '',
        isChecked ? 'checked' : '',
        isDisabled ? 'disabled' : '',
        className || ''
    ].filter(Boolean).join(' ');

    const toggle = () => {
        if (!canToggle) {
            return;
        }
        onChange(!isChecked);
    };

    const handleKeyDown = (event) => {
        if (!canToggle) {
            return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    };

    return (
        <div
            className={rowClassName}
            role="switch"
            aria-checked={isChecked}
            aria-disabled={isDisabled ? 'true' : undefined}
            onClick={canToggle ? toggle : undefined}
            onKeyDown={canToggle ? handleKeyDown : undefined}
            tabIndex={canToggle ? 0 : undefined}
            title={typeof title === 'string' && title.trim() ? title.trim() : undefined}
        >
            <div className="dialog-toggle-label-group">
                {hasLabel ? <span className="dialog-toggle-label">{resolvedLabel}</span> : null}
                {hasDescription ? <span className="dialog-toggle-description">{resolvedDescription}</span> : null}
            </div>
            <div className="dialog-toggle-right">
                <span className={`dialog-toggle-switch${isChecked ? ' checked' : ''}`} aria-hidden="true">
                    <span className="dialog-toggle-switch-track"></span>
                </span>
            </div>
        </div>
    );
}


export function DialogHeader({ title, icon, onClose }) {
    const hasTitle = typeof title === 'string' && title.trim().length > 0;
    const resolvedTitle = hasTitle ? title.trim() : '';
    const resolvedIcon = typeof icon === 'string' && icon.trim().length > 0 ? icon.trim() : '';
    const canClose = typeof onClose === 'function';

    if (!hasTitle && !resolvedIcon && !canClose) {
        return null;
    }

    return (
        <div className="dialog-header">
            <div className="dialog-title-row">
                {resolvedIcon ? <span className="material-icons dialog-title-icon">{resolvedIcon}</span> : null}
                {hasTitle ? <h2 className="dialog-title">{resolvedTitle}</h2> : null}
            </div>
            {canClose ? (
                <button
                    type="button"
                    className="dialog-close-button"
                    onClick={onClose}
                    title="Close"
                    aria-label="Close"
                >
                    <span className="material-icons">close</span>
                </button>
            ) : null}
        </div>
    );
}


export function Dialog({ children, className, visible, setVisible }) {
    const [shouldRender, setShouldRender] = useState(visible);
    const [animationClass, setAnimationClass] = useState('');
    const childArray = React.Children.toArray(children);
    let dialogHeader = null;
    const dialogBodyChildren = [];

    childArray.forEach((child) => {
        if (!dialogHeader && React.isValidElement(child) && child.type === DialogHeader) {
            dialogHeader = child;
            return;
        }
        dialogBodyChildren.push(child);
    });

    useEffect(() => {
        if (visible) {
            setShouldRender(true);
            // Trigger enter animation on next frame
            requestAnimationFrame(() => {
                setAnimationClass('dialog-enter');
            });
        } else if (shouldRender) {
            // Trigger exit animation
            setAnimationClass('dialog-exit');
        }
    }, [visible]);

    const handleAnimationEnd = () => {
        if (!visible) {
            setShouldRender(false);
            setAnimationClass('');
        }
    };

    if (!shouldRender) return null;

    return (
        <div
            className={`dialog-modal ${animationClass}`}
            onClick={() => setVisible(false)}
            onAnimationEnd={handleAnimationEnd}
        >
            <div
                className={`dialog${className ? ' ' + className : ''}`}
                onClick={(e) => e.stopPropagation()}
            >
                {dialogHeader}
                <div className="dialog-body">
                    {dialogBodyChildren}
                </div>
            </div>
        </div>
    );
}
