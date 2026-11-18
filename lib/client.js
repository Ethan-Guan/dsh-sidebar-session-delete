window.__ModuleLoader__.load({
	id: "session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var h = React.createElement;

		// ------------------------------------------------------------------
		// Pending delete request: one module-scoped store shared by the Session
		// row menu (which raises a request) and the shell overlay (which renders
		// the confirmation). Keeping it out of the menu item means the dialog
		// survives the menu closing.
		// ------------------------------------------------------------------
		var pending = null;
		var listeners = new Set();

		function notify() {
			for (var listener of Array.from(listeners)) {
				try {
					listener();
				} catch {
					/* one broken subscriber must not block the rest */
				}
			}
		}

		var dialogStore = {
			get: function () {
				return pending;
			},
			set: function (request) {
				pending = request;
				notify();
			},
			subscribe: function (listener) {
				listeners.add(listener);
				return function () {
					listeners.delete(listener);
				};
			}
		};

		function usePendingRequest() {
			var bound = React.useState(dialogStore.get);
			var request = bound[0];
			var setRequest = bound[1];
			React.useEffect(function () {
				return dialogStore.subscribe(function () {
					setRequest(dialogStore.get());
				});
			}, []);
			return request;
		}

		// ------------------------------------------------------------------
		// Session row menu entry: "删除会话".
		// ------------------------------------------------------------------
		function DeleteMenuItemBody(props) {
			return h(primitives.MenuItemButton, {
				icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: function () {
					if (typeof props.closeMenu === "function") props.closeMenu();
					dialogStore.set({ sessionId: props.sessionId, title: props.displayTitle || props.sessionId });
				}
			}, "删除会话");
		}

		// The item inherits the slot's `useMenuOpenState` hook when the owner
		// provides it; split components keep that hook unconditional.
		function DeleteMenuItemWithHooks(props) {
			var state = props.useMenuOpenState();
			var setOpen = state === undefined || state === null ? undefined : state[1];
			return h(DeleteMenuItemBody, Object.assign({}, props, {
				closeMenu: function () {
					if (typeof setOpen === "function") setOpen(false);
				}
			}));
		}

		function DeleteMenuItem(props) {
			if (typeof props.useMenuOpenState === "function") return h(DeleteMenuItemWithHooks, props);
			return h(DeleteMenuItemBody, props);
		}

		// ------------------------------------------------------------------
		// Confirmation dialog: rendered through the `shell.overlay` slot.
		// ------------------------------------------------------------------
		function DeleteConfirmDialog() {
			var request = usePendingRequest();
			if (request === null) return null;
			return h(DeleteConfirmForm, { key: request.sessionId, request: request });
		}

		function DeleteConfirmForm(props) {
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];

			var close = function () {
				if (busy) return;
				dialogStore.set(null);
			};

			var confirm = function () {
				if (busy) return;
				setBusy(true);
				setError(null);
				fetch("api/session-delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: props.request.sessionId })
				}).then(function (response) {
					return response.json().then(function (body) {
						return { response: response, body: body };
					});
				}).then(function (outcome) {
					if (!outcome.response.ok || outcome.body === null || outcome.body.ok !== true) {
						var message = outcome.body && outcome.body.error && outcome.body.error.message
							? outcome.body.error.message
							: "删除失败（HTTP " + outcome.response.status + "）";
						setBusy(false);
						setError(message);
						return;
					}
					// The Host announced the removal (`api-session/removed` for a cold
					// Session, `session/disposed` for a resident one) and dropped the
					// Workspace accounting, so the sidebar row disappears on its own —
					// no page reload, no full-app flash.
					dialogStore.set(null);
				}).catch(function (reason) {
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};

			return h(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: "关闭",
				title: "删除会话",
				description: "确定要永久删除「" + props.request.title + "」吗？该会话的记录与日志将被一并删除，且无法恢复。",
				footer: h(React.Fragment, null,
					h(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: close
					}, "取消"),
					h(primitives.Button, {
						variant: "outline",
						disabled: busy,
						style: { color: "var(--dsw-alias-state-error-primary)" },
						onClick: confirm
					}, busy ? "正在删除…" : "永久删除")
				)
			}, [
				busy ? h("div", {
					key: "status",
					role: "status",
					style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" }
				}, "正在删除会话…") : null,
				error === null ? null : h("div", {
					key: "error",
					role: "alert",
					style: { marginTop: 8, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" }
				}, error)
			]);
		}

		// ------------------------------------------------------------------
		// Client plugin: register the menu entry and the overlay dialog.
		// ------------------------------------------------------------------
		var inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
				return ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "session-delete",
					order: 440
				}, DeleteMenuItem);
			});
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "session-delete-confirm"
				}, DeleteConfirmDialog);
			});
			// Diagnostics heartbeat: lets the Host report whether a page mounted
			// this browser half (used to verify the menu is actually live).
			try {
				fetch("api/session-delete/ping", { method: "POST" }).catch(function () {
					/* the Host half may be disabled; the menu still renders */
				});
			} catch {
				/* fetch unavailable: ignore */
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
