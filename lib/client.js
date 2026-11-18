window.__ModuleLoader__.load({
	id: "dsh-sidebar-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var h = React.createElement;

		// ------------------------------------------------------------------
		// Pending delete request: one module-scoped store shared by the Session
		// row menu (which raises a request), the multi-select toolbar, and the
		// shell overlay (which renders the confirmation). Keeping it out of the
		// menu item means the dialog survives the menu closing.
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
		// Multi-select store: which rows the toolbar's selection mode owns.
		// The store is module-scoped so the toolbar (plain DOM, mounted outside
		// React) and the row decoration (a slot component) read the same state.
		// ------------------------------------------------------------------
		var selection = {
			active: false,
			ids: new Set(),
			version: 0,
			listeners: new Set()
		};

		function selectionNotify() {
			selection.version += 1;
			for (var listener of Array.from(selection.listeners)) {
				try {
					listener();
				} catch {
					/* one broken subscriber must not block the rest */
				}
			}
		}

		function selectionSubscribe(listener) {
			selection.listeners.add(listener);
			return function () {
				selection.listeners.delete(listener);
			};
		}

		function setSelectionActive(active) {
			if (selection.active === active) return;
			selection.active = active;
			if (!active) selection.ids.clear();
			selectionNotify();
			syncSelectionDom();
		}

		function toggleSelection(sessionId) {
			if (!selection.active) return;
			if (selection.ids.has(sessionId)) selection.ids.delete(sessionId);
			else selection.ids.add(sessionId);
			selectionNotify();
			syncSelectionDom();
		}

		function setSelectionIds(ids) {
			selection.ids = new Set(ids);
			selectionNotify();
			syncSelectionDom();
		}

		/**
		 * Subscribe one component to selection changes. The hook is called
		 * unconditionally so a row's decoration stays a stable component.
		 */
		function useSelectionVersion() {
			var state = React.useState(0);
			var setVersion = state[1];
			React.useEffect(function () {
				return selectionSubscribe(function () {
					setVersion(selection.version);
				});
			}, []);
			return state[0];
		}

		// ------------------------------------------------------------------
		// Session row menu entry: "删除会话".
		// ------------------------------------------------------------------
		function DeleteMenuItemBody(props) {
			return h(primitives.MenuItemButton, {
				icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: function () {
					if (typeof props.closeMenu === "function") props.closeMenu();
					dialogStore.set({
						sessionIds: [props.sessionId],
						title: props.displayTitle || props.sessionId,
						source: "menu"
					});
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
		// Selection mark: a small indicator in the row's trailing seat. It is
		// intentionally non-interactive (the trailing seat is an icon list);
		// clicking anywhere on the row toggles its membership instead.
		// ------------------------------------------------------------------
		function SelectionMark(props) {
			useSelectionVersion();
			if (!selection.active) return null;
			var selected = selection.ids.has(props.sessionId);
			return h("span", {
				"data-sds-mark": selected ? "selected" : "empty",
				"aria-hidden": "true",
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none",
					width: 14,
					height: 14,
					marginInlineStart: 4,
					color: selected ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-tertiary)",
					pointerEvents: "none"
				}
			}, selected
				? h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					h("circle", { cx: 8, cy: 8, r: 6.2, fill: "currentColor", opacity: 0.16 }),
					h("circle", { cx: 8, cy: 8, r: 6.2, stroke: "currentColor", strokeWidth: 1.3 }),
					h("path", { d: "M5.2 8.3l2 2 3.6-4.2", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }))
				: h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					h("circle", { cx: 8, cy: 8, r: 5.6, stroke: "currentColor", strokeWidth: 1.2, strokeDasharray: "2.4 2.2" })));
		}

		// ------------------------------------------------------------------
		// Delete requests: one batch call, with a per-Session fallback for a Host
		// that predates the batch route (the running process keeps the old Host
		// module until DSH restarts, while the refreshed page already has this
		// Client half).
		// ------------------------------------------------------------------
		function postJson(url, body) {
			return fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}).then(function (response) {
				return response.text().then(function (text) {
					var payload = null;
					try {
						payload = text === "" ? null : JSON.parse(text);
					} catch {
						payload = null;
					}
					return { response: response, body: payload };
				});
			});
		}

		/**
		 * Delete one or more Sessions. A missing batch route (404 without a
		 * structured body) falls back to the single-Session route, which every
		 * Host version has.
		 * @param sessionIds - ids to delete.
		 * @returns the same `{ response, body }` shape the batch route returns.
		 */
		function requestDeletion(sessionIds) {
			return postJson("api/session-delete/batch", { sessionIds: sessionIds }).then(function (outcome) {
				var routeMissing = outcome.response.status === 404
					&& (outcome.body === null || outcome.body.error === undefined);
				if (!routeMissing) return outcome;
				var results = [];
				return sessionIds.reduce(function (chain, sessionId) {
					return chain.then(function () {
						return postJson("api/session-delete", { sessionId: sessionId }).then(function (single) {
							var ok = single.response.ok && single.body !== null && single.body.ok === true;
							results.push(ok
								? { sessionId: sessionId, ok: true }
								: {
									sessionId: sessionId,
									ok: false,
									error: single.body && single.body.error
										? single.body.error
										: { code: "delete-failed", message: "删除失败（HTTP " + single.response.status + "）" }
								});
						}).catch(function (reason) {
							results.push({
								sessionId: sessionId,
								ok: false,
								error: { code: "delete-failed", message: reason instanceof Error ? reason.message : String(reason) }
							});
						});
					});
				}, Promise.resolve()).then(function () {
					var failed = results.filter(function (row) { return row.ok !== true; }).length;
					return {
						response: { ok: true, status: 200 },
						body: { ok: true, deleted: results.length - failed, failed: failed, results: results }
					};
				});
			});
		}

		// ------------------------------------------------------------------
		// Confirmation dialog: rendered through the `shell.overlay` slot. One
		// request may carry several Session ids (multi-select) or exactly one
		// (the row menu).
		// ------------------------------------------------------------------
		function DeleteConfirmDialog() {
			var request = usePendingRequest();
			if (request === null) return null;
			var key = Array.isArray(request.sessionIds) ? request.sessionIds.join(",") : String(request.sessionIds);
			return h(DeleteConfirmForm, { key: key, request: request });
		}

		function DeleteConfirmForm(props) {
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];

			var sessionIds = Array.isArray(props.request.sessionIds) ? props.request.sessionIds : [];
			// After a partial failure the dialog stays open with only the rows that
			// still failed, so retrying does not resend already-deleted ids.
			var retryState = React.useState(sessionIds);
			var retryIds = retryState[0];
			var setRetryIds = retryState[1];
			var count = retryIds.length;
			var fromSelection = props.request.source === "selection";

			var close = function () {
				if (busy) return;
				dialogStore.set(null);
			};

			var confirm = function () {
				if (busy || count === 0) return;
				setBusy(true);
				setError(null);
				requestDeletion(retryIds).then(function (outcome) {
					if (!outcome.response.ok || outcome.body === null || outcome.body.ok !== true) {
						var message = outcome.body && outcome.body.error && outcome.body.error.message
							? outcome.body.error.message
							: "删除失败（HTTP " + outcome.response.status + "）";
						setBusy(false);
						setError(message);
						return;
					}
					var results = Array.isArray(outcome.body.results) ? outcome.body.results : [];
					var failed = results.filter(function (row) { return row.ok !== true; });
					if (failed.length === 0) {
						// The Host announced every removal (`api-session/removed` for a
						// cold Session, `session/disposed` for a resident one), so the
						// sidebar rows disappear on their own — no page reload.
						dialogStore.set(null);
						if (fromSelection) setSelectionActive(false);
						return;
					}
					var failedIds = failed.map(function (row) { return row.sessionId; });
					if (fromSelection) setSelectionIds(failedIds);
					setRetryIds(failedIds);
					var first = failed[0];
					var reason = first && first.error && first.error.message ? first.error.message : "未知错误";
					setError("已删除 " + (results.length - failed.length) + " 个，失败 " + failed.length + " 个：" + reason);
					setBusy(false);
				}).catch(function (reason) {
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};

			var title = count === 1
				? "删除会话"
				: "删除 " + count + " 个会话";
			var description = count === 1
				? "确定要永久删除「" + (props.request.title || sessionIds[0]) + "」吗？该会话的记录与日志将被一并删除，且无法恢复。"
				: "确定要永久删除选中的 " + count + " 个会话吗？它们的记录与日志将被一并删除，且无法恢复。";

			return h(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: "关闭",
				title: title,
				description: description,
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
					}, busy ? "正在删除…" : (count === 1 ? "永久删除" : "全部删除"))
				)
			}, [
				busy ? h("div", {
					key: "status",
					role: "status",
					style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" }
				}, count === 1 ? "正在删除会话…" : "正在逐个删除会话…") : null,
				error === null ? null : h("div", {
					key: "error",
					role: "alert",
					style: { marginTop: 8, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" }
				}, error)
			]);
		}

		// ------------------------------------------------------------------
		// Multi-select toolbar. The sidebar's workspace section exposes no slot
		// for its header actions, so the toggle button is mounted into the
		// toolbar's stable `data-sidebar-workspace-header` marker and the
		// selection bar into the same section root (which is position:relative).
		// Both are plain DOM driven by the store above; the plug-in removes them
		// when its client module is disposed.
		// ------------------------------------------------------------------
		var dom = {
			header: null,
			root: null,
			button: null,
			bar: null,
			count: null,
			allButton: null,
			deleteButton: null,
			raf: 0
		};

		var STYLE_ID = "dsh-session-delete-style";

		var STYLE_TEXT = [
			".sds-session-delete-toggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}",
			".sds-session-delete-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".sds-session-delete-toggle[aria-pressed='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary);}",
			".sds-session-delete-toggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px;}",
			".sds-session-delete-bar{position:absolute;left:8px;right:8px;bottom:10px;z-index:30;display:none;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-interactive-bg-hover));box-shadow:0 6px 20px rgba(0,0,0,.18);}",
			".sds-session-delete-bar[data-open='true']{display:flex;}",
			".sds-session-delete-count{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);}",
			".sds-session-delete-bar button{flex:none;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;}",
			".sds-session-delete-bar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
			".sds-session-delete-bar button[data-sds-act='delete']{color:var(--dsw-alias-state-error-primary);}",
			".sds-session-delete-bar button:disabled{opacity:.45;cursor:default;}",
			".sds-session-delete-bar button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px;}",
			"[data-sds-selected]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)!important;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary);border-radius:6px;}"
		].join("\n");

		/**
		 * Append the style sheet once; a second mount (HMR) reuses it.
		 */
		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STYLE_TEXT;
			document.head.appendChild(style);
		}

		/**
		 * Build the toggle button in the workspace toolbar.
		 */
		function createToggle() {
			var button = document.createElement("button");
			button.type = "button";
			button.className = "sds-session-delete-toggle";
			button.title = "多选会话";
			button.setAttribute("aria-label", "多选会话");
			button.setAttribute("aria-pressed", "false");
			button.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
				+ '<rect x="1.6" y="2.9" width="3.4" height="3.4" rx="1" stroke="currentColor" stroke-width="1.3"/>'
				+ '<rect x="1.6" y="9.7" width="3.4" height="3.4" rx="1" stroke="currentColor" stroke-width="1.3"/>'
				+ '<path d="M7 4.6h7.4M7 11.4h7.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
				+ '</svg>';
			button.addEventListener("click", function (event) {
				event.preventDefault();
				event.stopPropagation();
				setSelectionActive(!selection.active);
			});
			return button;
		}

		/**
		 * Build the floating selection bar inside the workspaces section.
		 */
		function createBar() {
			var bar = document.createElement("div");
			bar.className = "sds-session-delete-bar";
			bar.setAttribute("data-open", "false");
			bar.innerHTML = '<span class="sds-session-delete-count">已选 0 个会话</span>'
				+ '<button type="button" data-sds-act="all">全选</button>'
				+ '<button type="button" data-sds-act="delete" disabled>删除</button>'
				+ '<button type="button" data-sds-act="cancel">取消</button>';
			bar.addEventListener("click", function (event) {
				var target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				var action = target.closest("button[data-sds-act]");
				if (action === null) return;
				event.preventDefault();
				event.stopPropagation();
				var act = action.getAttribute("data-sds-act");
				if (act === "cancel") {
					setSelectionActive(false);
					return;
				}
				if (act === "all") {
					var visible = visibleSessionIds();
					var allSelected = visible.length > 0 && visible.every(function (id) { return selection.ids.has(id); });
					setSelectionIds(allSelected ? [] : visible);
					return;
				}
				if (act === "delete" && selection.ids.size > 0) {
					dialogStore.set({
						sessionIds: Array.from(selection.ids),
						source: "selection"
					});
				}
			});
			dom.count = bar.querySelector(".sds-session-delete-count");
			dom.allButton = bar.querySelector("button[data-sds-act='all']");
			dom.deleteButton = bar.querySelector("button[data-sds-act='delete']");
			return bar;
		}

		/**
		 * Session ids currently rendered in the sidebar's list area.
		 * @returns the ids in DOM order.
		 */
		function visibleSessionIds() {
			var listArea = document.querySelector("[data-sidebar-list-area]");
			if (listArea === null) return [];
			var rows = listArea.querySelectorAll('[data-row-key^="session:"]');
			var ids = [];
			for (var row of Array.from(rows)) {
				var key = row.getAttribute("data-row-key");
				if (typeof key === "string" && key.length > 8) ids.push(key.slice(8));
			}
			return ids;
		}

		/**
		 * Repaint every selected row's attribute; attributes survive React
		 * re-renders (unlike a className), so a row keeps its mark until the
		 * selection changes or the row leaves the DOM.
		 */
		function applyRowMarks() {
			var listArea = document.querySelector("[data-sidebar-list-area]");
			if (listArea === null) return;
			for (var row of Array.from(listArea.querySelectorAll("[data-row-key^='session:']"))) {
				var key = row.getAttribute("data-row-key");
				var sessionId = typeof key === "string" ? key.slice(8) : "";
				if (selection.active && selection.ids.has(sessionId)) row.setAttribute("data-sds-selected", "");
				else row.removeAttribute("data-sds-selected");
			}
		}

		/**
		 * Push the current store state into the DOM controls.
		 */
		function syncSelectionDom() {
			if (typeof document === "undefined") return;
			if (dom.button !== null) dom.button.setAttribute("aria-pressed", selection.active ? "true" : "false");
			if (dom.bar !== null) {
				dom.bar.setAttribute("data-open", selection.active ? "true" : "false");
				if (dom.count !== null) dom.count.textContent = "已选 " + selection.ids.size + " 个会话";
				if (dom.deleteButton !== null) dom.deleteButton.disabled = selection.ids.size === 0;
				if (dom.allButton !== null) {
					var visible = visibleSessionIds();
					var allSelected = visible.length > 0 && visible.every(function (id) { return selection.ids.has(id); });
					dom.allButton.textContent = allSelected ? "取消全选" : "全选";
				}
			}
			applyRowMarks();
		}

		/**
		 * Find the toolbar and section root, mounting the controls when they
		 * first appear (or re-mounting them after a React replacement).
		 */
		function ensureAnchors() {
			if (typeof document === "undefined") return;
			var header = document.querySelector("[data-sidebar-workspace-header]");
			if (header === null) {
				dom.header = null;
				dom.root = null;
				return;
			}
			var root = header.parentElement;
			if (dom.button === null) dom.button = createToggle();
			if (dom.bar === null) dom.bar = createBar();
			if (dom.header !== header) {
				dom.header = header;
				dom.root = root;
			}
			if (!header.contains(dom.button)) header.appendChild(dom.button);
			if (root !== null && dom.bar.parentElement !== root) root.appendChild(dom.bar);
			var narrow = root !== null && root.getBoundingClientRect().width < 120;
			dom.button.style.display = narrow ? "none" : "";
			dom.bar.style.display = narrow ? "none" : "";
			syncSelectionDom();
		}

		/**
		 * Mount the toolbar controls; returns the teardown for ctx.effect.
		 */
		function mountToolbar() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
				return function () {};
			}
			ensureStyle();
			var schedule = function () {
				if (dom.raf !== 0) return;
				dom.raf = requestAnimationFrame(function () {
					dom.raf = 0;
					ensureAnchors();
				});
			};
			var observer = new MutationObserver(schedule);
			observer.observe(document.documentElement, { childList: true, subtree: true });
			var onResize = function () { schedule(); };
			window.addEventListener("resize", onResize);
			var onKeyDown = function (event) {
				if (!selection.active) return;
				if (event.key !== "Escape") return;
				var target = event.target;
				var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
				if (tag === "input" || tag === "textarea") return;
				event.preventDefault();
				setSelectionActive(false);
			};
			document.addEventListener("keydown", onKeyDown, true);
			var onClick = function (event) {
				if (!selection.active) return;
				var target = event.target;
				if (target === null || typeof target.closest !== "function") return;
				var listArea = document.querySelector("[data-sidebar-list-area]");
				if (listArea === null || !listArea.contains(target)) return;
				var row = target.closest("[data-row-key^='session:']");
				if (row === null || !listArea.contains(row)) return;
				// Row action buttons ("..." menu, archive/pin) keep working; only
				// presses on the row body select.
				if (target.closest("button, a, input, textarea, select, [role='menuitem']") !== null) return;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				var key = row.getAttribute("data-row-key");
				if (typeof key === "string" && key.length > 8) toggleSelection(key.slice(8));
			};
			document.addEventListener("click", onClick, true);
			ensureAnchors();
			return function () {
				observer.disconnect();
				window.removeEventListener("resize", onResize);
				document.removeEventListener("keydown", onKeyDown, true);
				document.removeEventListener("click", onClick, true);
				if (dom.button !== null && dom.button.parentElement !== null) dom.button.parentElement.removeChild(dom.button);
				if (dom.bar !== null && dom.bar.parentElement !== null) dom.bar.parentElement.removeChild(dom.bar);
				dom.button = null;
				dom.bar = null;
				dom.count = null;
				dom.allButton = null;
				dom.deleteButton = null;
				dom.header = null;
				dom.root = null;
			};
		}

		// ------------------------------------------------------------------
		// Client plugin: register the menu entry, the selection mark, the
		// overlay dialog, and the multi-select toolbar.
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
			ctx.slots.inject("sidebar.session.row.trailing", function () {
				return ctx.slots.register({
					name: "sidebar.session.row.trailing",
					id: "session-delete-selection",
					order: 5
				}, SelectionMark);
			});
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "session-delete-confirm"
				}, DeleteConfirmDialog);
			});
			if (typeof ctx.effect === "function") {
				ctx.effect(mountToolbar, "session-delete: multi-select toolbar");
			}
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
