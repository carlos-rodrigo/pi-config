/**
 * Review Hub — Web application
 *
 * Vanilla JS single-page app with three modules:
 * - ApiClient: HTTP communication with the review server
 * - CommentPanel: Comment CRUD + display
 * - ReviewApp: App initialization, state management, layout wiring
 */

// ── Type Icons & Labels ────────────────────────────────────────────────────

const TYPE_ICONS = {
  change: "🔄",
  question: "❓",
  approval: "✅",
  concern: "⚠️",
};

const TYPE_LABELS = {
  change: "Change",
  question: "Question",
  approval: "Approval",
  concern: "Concern",
};

// ── Utility ────────────────────────────────────────────────────────────────

function relativeTime(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatAudioTimestamp(seconds) {
  if (seconds == null) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── API Client ─────────────────────────────────────────────────────────────

const ApiClient = {
  token: null,

  init(token) {
    this.token = token;
  },

  async _fetch(url, options = {}) {
    const headers = { ...options.headers };
    if (this.token) {
      headers["X-Session-Token"] = this.token;
    }

    let attempt = 0;
    while (attempt < 2) {
      try {
        const res = await fetch(url, { ...options, headers });
        return res;
      } catch (err) {
        attempt++;
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  },

  async fetchManifest() {
    const res = await this._fetch("/manifest.json");
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
    return await res.json();
  },

  async saveComment(comment) {
    const res = await this._fetch("/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(comment),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Save failed: ${res.status}`);
    }
    return await res.json();
  },

  async deleteComment(id) {
    const res = await this._fetch(`/comments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `Delete failed: ${res.status}`);
    }
    return await res.json();
  },

  async completeReview() {
    const res = await this._fetch("/complete", {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Complete failed: ${res.status}`);
    return await res.json();
  },
};

// ── Comment Panel ──────────────────────────────────────────────────────────

const CommentPanel = {
  activeFilter: "all",
  editingCommentId: null,
  formVisible: false,
  formPreset: null, // { sectionId?, audioTimestamp? }

  init() {
    // Filter buttons
    document.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.activeFilter = btn.dataset.filter;
        document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.render();
      });
    });

    // Add Comment button
    document.getElementById("btn-add-comment").addEventListener("click", () => {
      this.showForm();
    });

    // Save button
    document.getElementById("btn-save-comment").addEventListener("click", () => {
      this.saveFromForm();
    });

    // Cancel button
    document.getElementById("btn-cancel-comment").addEventListener("click", () => {
      this.hideForm();
    });

    // Allow Ctrl+Enter in textarea
    document.getElementById("form-text").addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.saveFromForm();
      }
    });
  },

  populateSectionDropdown(sections) {
    const select = document.getElementById("form-section");
    select.innerHTML = "";
    for (const section of sections) {
      const opt = document.createElement("option");
      opt.value = section.id;
      const depth = section.headingLevel - 1;
      opt.textContent = "  ".repeat(depth) + section.headingPath[section.headingPath.length - 1];
      select.appendChild(opt);
    }
  },

  showForm(preset = null) {
    this.formPreset = preset;
    this.editingCommentId = null;
    const form = document.getElementById("comment-form");
    form.style.display = "block";

    // Reset form
    document.getElementById("form-text").value = "";
    document.querySelector('input[name="comment-type"][value="change"]').checked = true;
    document.querySelector('input[name="comment-priority"][value="medium"]').checked = true;

    // Apply preset
    if (preset?.sectionId) {
      document.getElementById("form-section").value = preset.sectionId;
    }

    document.getElementById("form-text").focus();
  },

  showFormForEdit(comment) {
    this.editingCommentId = comment.id;
    const form = document.getElementById("comment-form");
    form.style.display = "block";

    document.getElementById("form-section").value = comment.sectionId;
    document.getElementById("form-text").value = comment.text;

    const typeRadio = document.querySelector(`input[name="comment-type"][value="${comment.type}"]`);
    if (typeRadio) typeRadio.checked = true;

    const priorityRadio = document.querySelector(`input[name="comment-priority"][value="${comment.priority}"]`);
    if (priorityRadio) priorityRadio.checked = true;

    document.getElementById("form-text").focus();
  },

  hideForm() {
    document.getElementById("comment-form").style.display = "none";
    this.editingCommentId = null;
    this.formPreset = null;
  },

  async saveFromForm() {
    const sectionId = document.getElementById("form-section").value;
    const text = document.getElementById("form-text").value.trim();
    const type = document.querySelector('input[name="comment-type"]:checked')?.value;
    const priority = document.querySelector('input[name="comment-priority"]:checked')?.value;

    if (!text) {
      document.getElementById("form-text").focus();
      return;
    }

    const commentData = {
      sectionId,
      type,
      priority,
      text,
    };

    // Preserve ID if editing
    if (this.editingCommentId) {
      commentData.id = this.editingCommentId;
    }

    // Preserve audio timestamp from preset
    if (this.formPreset?.audioTimestamp != null) {
      commentData.audioTimestamp = this.formPreset.audioTimestamp;
    }

    try {
      const saved = await ApiClient.saveComment(commentData);

      // Update state
      if (this.editingCommentId) {
        const idx = ReviewApp.state.comments.findIndex((c) => c.id === this.editingCommentId);
        if (idx >= 0) ReviewApp.state.comments[idx] = saved;
      } else {
        ReviewApp.state.comments.push(saved);
      }

      this.hideForm();
      this.render();
    } catch (err) {
      console.error("Failed to save comment:", err);
      alert("Failed to save comment: " + err.message);
    }
  },

  async deleteComment(id) {
    if (!confirm("Delete this comment?")) return;

    try {
      await ApiClient.deleteComment(id);
      ReviewApp.state.comments = ReviewApp.state.comments.filter((c) => c.id !== id);
      this.render();
    } catch (err) {
      console.error("Failed to delete comment:", err);
      alert("Failed to delete: " + err.message);
    }
  },

  /** Open a new comment form pre-anchored to a section (called from visual presenter). */
  openNew(preset) {
    this.showForm(preset);
  },

  render() {
    const list = document.getElementById("comment-list");
    const countEl = document.getElementById("comment-count");

    const comments = ReviewApp.state.comments;
    const filtered =
      this.activeFilter === "all"
        ? comments
        : comments.filter((c) => c.type === this.activeFilter);

    countEl.textContent = `(${comments.length})`;

    if (filtered.length === 0) {
      list.innerHTML = `<div class="comment-empty">${
        comments.length === 0
          ? "No comments yet. Click + to add one."
          : "No " + this.activeFilter + " comments."
      }</div>`;
      return;
    }

    // Sort by creation time (newest first)
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    list.innerHTML = sorted
      .map((comment) => {
        const section = ReviewApp.state.manifest?.sections.find((s) => s.id === comment.sectionId);
        const sectionTitle = section
          ? section.headingPath[section.headingPath.length - 1]
          : comment.sectionId;
        const audioTs = formatAudioTimestamp(comment.audioTimestamp);

        return `
          <div class="comment-item" data-comment-id="${escapeHtml(comment.id)}">
            <div class="comment-header">
              <span class="comment-type-icon">${TYPE_ICONS[comment.type] || "📝"}</span>
              <span class="comment-priority-dot ${comment.priority}"></span>
              <span class="comment-section-title">${escapeHtml(sectionTitle)}</span>
              <button class="comment-delete" data-delete-id="${escapeHtml(comment.id)}" title="Delete">×</button>
            </div>
            <div class="comment-text">${escapeHtml(comment.text)}</div>
            <div class="comment-meta">
              <span>${relativeTime(comment.createdAt)}</span>
              ${audioTs ? `<span class="comment-audio-timestamp" data-timestamp="${comment.audioTimestamp}">🎙️ ${audioTs}</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    // Attach event handlers
    list.querySelectorAll(".comment-item").forEach((el) => {
      const id = el.dataset.commentId;

      // Click to edit
      el.addEventListener("click", (e) => {
        if (e.target.closest(".comment-delete") || e.target.closest(".comment-audio-timestamp"))
          return;
        const comment = ReviewApp.state.comments.find((c) => c.id === id);
        if (comment) this.showFormForEdit(comment);
      });
    });

    list.querySelectorAll(".comment-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteComment(btn.dataset.deleteId);
      });
    });
  },
};

// ── Sync Manager ───────────────────────────────────────────────────────────

const SyncManager = {
  /** Called when audio playback reaches a time position. */
  onAudioTime(seconds) {
    const manifest = ReviewApp.state.manifest;
    if (!manifest) return;

    const section = manifest.sections.find(
      (s) =>
        s.audioStartTime != null &&
        s.audioEndTime != null &&
        seconds >= s.audioStartTime &&
        seconds < s.audioEndTime,
    );

    if (section && section.id !== ReviewApp.state.currentSection) {
      ReviewApp.updateCurrentSection(section.id);
      VisualPresenter.scrollToSection(section.id);
    }
  },

  /** Called when user scrolls the visual presentation. */
  onVisualScroll(sectionId) {
    if (sectionId !== ReviewApp.state.currentSection) {
      ReviewApp.updateCurrentSection(sectionId);
      // Don't seek audio — visual browsing is independent
    }
  },
};

// ── Visual Presenter ───────────────────────────────────────────────────────

const VisualPresenter = {
  observer: null,
  sectionElements: [],

  async init() {
    const visualZone = document.getElementById("visual-zone");
    if (!visualZone) return;

    try {
      // Fetch generated visual HTML
      const res = await fetch("/visual");
      if (!res.ok) {
        visualZone.innerHTML = `<div class="visual-placeholder"><p>Visual presentation unavailable.</p></div>`;
        return;
      }

      const html = await res.text();
      visualZone.innerHTML = html;

      // Setup intersection observer for scroll animations
      this.setupScrollAnimations();

      // Setup section comment buttons
      this.setupCommentButtons();

      // Setup progress nav
      this.setupProgressNav();

      // Setup click-to-scroll on comments
      this.setupCommentScrolling();
    } catch (err) {
      console.error("Failed to load visual:", err);
      visualZone.innerHTML = `<div class="visual-placeholder"><p>Failed to load visual presentation.</p></div>`;
    }
  },

  setupScrollAnimations() {
    this.sectionElements = Array.from(document.querySelectorAll(".review-section"));

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");

            // Track current section
            const sectionId = entry.target.getAttribute("data-section-id");
            if (sectionId) {
              SyncManager.onVisualScroll(sectionId);
              this.updateProgressNav(sectionId);
            }
          }
        }
      },
      {
        root: document.querySelector(".visual-content") || document.querySelector(".content-area"),
        threshold: 0.15,
        rootMargin: "0px 0px -10% 0px",
      },
    );

    for (const el of this.sectionElements) {
      this.observer.observe(el);
    }
  },

  setupCommentButtons() {
    document.querySelectorAll(".section-comment-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sectionId = btn.getAttribute("data-section-id");
        if (sectionId) {
          CommentPanel.openNew({ sectionId });

          // Brief highlight effect
          const section = btn.closest(".review-section");
          if (section) {
            section.style.outline = "1px solid var(--accent)";
            section.style.outlineOffset = "4px";
            setTimeout(() => {
              section.style.outline = "";
              section.style.outlineOffset = "";
            }, 1500);
          }
        }
      });
    });
  },

  setupProgressNav() {
    document.querySelectorAll(".progress-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const sectionId = item.getAttribute("data-section-id");
        if (sectionId) {
          this.scrollToSection(sectionId);
        }
      });
    });
  },

  setupCommentScrolling() {
    // This patches the comment panel's render to add scroll-to-section on click
    const originalRender = CommentPanel.render.bind(CommentPanel);
    CommentPanel.render = () => {
      originalRender();

      // After rendering, add click handlers to scroll to sections
      document.querySelectorAll(".comment-section-title").forEach((el) => {
        const commentItem = el.closest(".comment-item");
        if (!commentItem) return;
        const commentId = commentItem.dataset.commentId;
        const comment = ReviewApp.state.comments.find((c) => c.id === commentId);
        if (comment) {
          el.style.cursor = "pointer";
          el.title = "Click to scroll to section";
        }
      });
    };
  },

  updateProgressNav(activeSectionId) {
    document.querySelectorAll(".progress-item").forEach((item) => {
      if (item.getAttribute("data-section-id") === activeSectionId) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });
  },

  scrollToSection(sectionId) {
    const el = document.querySelector(`.review-section[data-section-id="${sectionId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("visible");

      // Brief highlight
      el.style.outline = "1px solid var(--accent-dim)";
      el.style.outlineOffset = "4px";
      setTimeout(() => {
        el.style.outline = "";
        el.style.outlineOffset = "";
      }, 1200);
    }

    this.updateProgressNav(sectionId);
  },

  /** Highlight a specific section (e.g., from comment panel click). */
  highlightSection(sectionId) {
    this.updateProgressNav(sectionId);
  },
};

// ── Review App ─────────────────────────────────────────────────────────────

const ReviewApp = {
  state: {
    manifest: null,
    comments: [],
    currentSection: null,
    token: null,
  },

  async init() {
    // Extract token from URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      document.body.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#fc8181;">Missing session token. Open the URL provided by pi.</div>';
      return;
    }

    this.state.token = token;
    ApiClient.init(token);

    try {
      // Fetch manifest
      const manifest = await ApiClient.fetchManifest();
      this.state.manifest = manifest;
      this.state.comments = manifest.comments || [];

      // Render layout
      this.renderHeader(manifest);
      CommentPanel.init();
      CommentPanel.populateSectionDropdown(manifest.sections);
      CommentPanel.render();

      // Initialize visual presenter
      await VisualPresenter.init();

      // Done Reviewing button
      document.getElementById("btn-done").addEventListener("click", () => {
        this.handleDoneReviewing();
      });

      // Update section indicator
      this.updateCurrentSection(null);
    } catch (err) {
      console.error("Failed to initialize:", err);
      document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#fc8181;">Failed to load review: ${escapeHtml(err.message)}</div>`;
    }
  },

  renderHeader(manifest) {
    // Document name
    const docName = document.getElementById("document-name");
    docName.textContent = manifest.source;

    // Language badge
    const langBadge = document.getElementById("lang-badge");
    langBadge.textContent = manifest.language.toUpperCase();

    // Show player zone if audio exists
    if (manifest.audio) {
      document.getElementById("player-zone").style.display = "block";
    }
  },

  updateCurrentSection(sectionId) {
    this.state.currentSection = sectionId;
    const el = document.getElementById("current-section");
    if (!sectionId) {
      el.textContent = "Ready";
      return;
    }
    const section = this.state.manifest?.sections.find((s) => s.id === sectionId);
    if (section) {
      el.textContent = "Section: " + section.headingPath.join(" ▸ ");
    }
  },

  async handleDoneReviewing() {
    const comments = this.state.comments;
    const typeCounts = {};
    for (const c of comments) {
      typeCounts[c.type] = (typeCounts[c.type] || 0) + 1;
    }

    const summary = Object.entries(typeCounts)
      .map(([type, count]) => `${count} ${TYPE_LABELS[type] || type}`)
      .join(", ");

    const msg = `Mark review as complete?\n\n${comments.length} comments: ${summary || "none"}`;
    if (!confirm(msg)) return;

    try {
      const result = await ApiClient.completeReview();

      // Show completion overlay
      const summaryEl = document.getElementById("completion-summary");
      summaryEl.innerHTML = `
        <p><strong>${comments.length}</strong> comments submitted</p>
        ${summary ? `<p>${summary}</p>` : ""}
        <p style="margin-top:8px;">Completed at ${new Date(result.completedAt).toLocaleTimeString()}</p>
      `;
      document.getElementById("completion-overlay").style.display = "flex";
    } catch (err) {
      console.error("Failed to complete review:", err);
      alert("Failed to complete review: " + err.message);
    }
  },
};

// ── Initialize ─────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  ReviewApp.init();
});

// Export for use by other modules (audio player in task 010)
window.ReviewApp = ReviewApp;
window.CommentPanel = CommentPanel;
window.ApiClient = ApiClient;
window.VisualPresenter = VisualPresenter;
window.SyncManager = SyncManager;
