/**
 * Tejas Computer Institute - Main JavaScript
 * Handles interactions, animations, and API calls
 */

document.addEventListener('DOMContentLoaded', function() {
    // Initialize all functions
    initThemeSystem();
    initUserSessionUI();
    initUserSessionGuard();
    initAnnouncementBar();
    initNavbar();
    initScrollAnimation();
    initContactForm();
    initCourseCards();
    initCourseFinder();
    initFaqAccordion();
    initBackToTop();
    initGallery();
    initCounterAnimation();
    initPremiumUX();
    initPersonalizedHomepage();
    initHomeGeminiAssistant();
    initCareerDnaMatcher();
});

const THEME_STORAGE_KEY = 'tci-theme';
const USER_TOKEN_STORAGE_KEY = 'userToken';
const THEME_CATALOG = [
    { id: 'light', label: 'Light Classic', icon: 'fa-sun' },
    { id: 'dark', label: 'Dark Mode', icon: 'fa-moon' },
    { id: 'ocean', label: 'Ocean Blue', icon: 'fa-water' },
    { id: 'emerald', label: 'Emerald', icon: 'fa-leaf' },
    { id: 'sunset', label: 'Sunset Orange', icon: 'fa-sun' },
    { id: 'rose', label: 'Rose Bloom', icon: 'fa-seedling' },
    { id: 'forest', label: 'Forest Green', icon: 'fa-tree' },
    { id: 'slate', label: 'Slate Steel', icon: 'fa-mountain-city' },
    { id: 'citrus', label: 'Citrus Lime', icon: 'fa-lemon' },
    { id: 'ruby', label: 'Ruby Red', icon: 'fa-gem' },
    { id: 'midnight', label: 'Midnight Sky', icon: 'fa-moon' }
];

function getThemeCatalog() {
    return THEME_CATALOG.slice();
}

function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
}

function applySiteTheme(themeId, options = {}) {
    const { persist = true } = options;
    const normalizedId = String(themeId || '').trim().toLowerCase();
    const isSupported = THEME_CATALOG.some(theme => theme.id === normalizedId);
    const finalTheme = isSupported ? normalizedId : 'light';

    document.documentElement.setAttribute('data-theme', finalTheme);
    if (persist) {
        localStorage.setItem(THEME_STORAGE_KEY, finalTheme);
    }

    document.querySelectorAll('[data-theme-choice]').forEach(button => {
        const isActive = button.getAttribute('data-theme-choice') === finalTheme;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    const status = document.getElementById('themeSwitcherStatus');
    if (status) {
        const theme = THEME_CATALOG.find(item => item.id === finalTheme);
        status.textContent = `Active theme: ${theme ? theme.label : 'Light Classic'}`;
    }

    document.dispatchEvent(new CustomEvent('site-theme-change', {
        detail: { theme: finalTheme }
    }));
}

function renderFloatingThemeSwitcher() {
    if (document.getElementById('themeSwitcher')) return;

    const host = document.createElement('div');
    host.className = 'theme-switcher';
    host.id = 'themeSwitcher';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'theme-fab';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'themePanel');
    trigger.innerHTML = '<i class="fas fa-palette"></i>';

    const panel = document.createElement('div');
    panel.className = 'theme-panel';
    panel.id = 'themePanel';
    panel.innerHTML = `
        <div class="theme-panel-title">Themes</div>
        <div class="theme-grid">
            ${THEME_CATALOG.map(theme => `
                <button type="button" class="theme-chip" data-theme-choice="${theme.id}">
                    <i class="fas ${theme.icon}"></i> ${theme.label}
                </button>
            `).join('')}
        </div>
        <div class="theme-status" id="themeSwitcherStatus">Active theme: Light Classic</div>
    `;

    host.appendChild(trigger);
    host.appendChild(panel);
    document.body.appendChild(host);

    trigger.addEventListener('click', () => {
        const isOpen = host.classList.toggle('open');
        trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    panel.querySelectorAll('[data-theme-choice]').forEach(button => {
        button.addEventListener('click', () => {
            applySiteTheme(button.getAttribute('data-theme-choice'));
        });
    });

    document.addEventListener('click', (event) => {
        if (!host.contains(event.target)) {
            host.classList.remove('open');
            trigger.setAttribute('aria-expanded', 'false');
        }
    });
}

function initThemeSystem() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
    applySiteTheme(savedTheme, { persist: false });
    renderFloatingThemeSwitcher();
}

function getStoredUserToken() {
    return String(localStorage.getItem(USER_TOKEN_STORAGE_KEY) || '').trim();
}

function getUserAuthHeaders(extraHeaders = {}) {
    const token = getStoredUserToken();
    if (!token) return { ...extraHeaders };
    return {
        ...extraHeaders,
        Authorization: `Bearer ${token}`
    };
}

window.getThemeCatalog = getThemeCatalog;
window.getCurrentTheme = getCurrentTheme;
window.applySiteTheme = applySiteTheme;
window.getStoredUserToken = getStoredUserToken;
window.getUserAuthHeaders = getUserAuthHeaders;

/**
 * Site-wide announcement bar controlled by admin panel
 */
async function initAnnouncementBar() {
    const header = document.querySelector('.header');
    if (!header) return;

    try {
        const response = await fetch('/api/announcement');
        if (!response.ok) return;
        const data = await response.json();
        if (!data.active || !data.message) return;

        const dismissKey = data.updatedAt ? `announcementDismissed::${data.updatedAt}` : '';
        if (dismissKey && localStorage.getItem(dismissKey) === '1') return;

        const bar = document.createElement('div');
        bar.className = `announcement-bar announcement-${data.type || 'info'}`;
        const titleHtml = data.title ? `<strong>${data.title}</strong>` : '';
        const ctaHtml = data.ctaText && data.ctaUrl
            ? `<a class="announcement-cta" href="${data.ctaUrl}" target="_blank" rel="noopener noreferrer">${data.ctaText}</a>`
            : '';
        const closeHtml = data.dismissible === false
            ? ''
            : `<button type="button" class="announcement-close" aria-label="Dismiss announcement">
                <i class="fas fa-times"></i>
            </button>`;
        bar.innerHTML = `
            <div class="announcement-content">
                <i class="fas fa-bullhorn"></i>
                <span>${titleHtml}${titleHtml ? ' - ' : ''}${data.message}</span>
                ${ctaHtml}
            </div>
            ${closeHtml}
        `;

        const closeBtn = bar.querySelector('.announcement-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                bar.remove();
                document.body.classList.remove('with-announcement');
                if (dismissKey) {
                    localStorage.setItem(dismissKey, '1');
                }
            });
        }

        document.body.classList.add('with-announcement');
        document.body.insertBefore(bar, header);
    } catch (error) {
        // Silent fail: announcement should never block page interaction.
    }
}

/**
 * Keep login state consistent across pages
 */
function initUserSessionUI() {
    const userRaw = localStorage.getItem('user');
    if (!userRaw) return;

    let user;
    try {
        user = JSON.parse(userRaw);
    } catch (error) {
        localStorage.removeItem('user');
        localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
        return;
    }

    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (currentPage === 'login.html' || currentPage === 'register.html') {
        window.location.href = 'dashboard.html';
        return;
    }

    const loginBtn = document.querySelector('.btn-login');
    const registerBtn = document.querySelector('.btn-register');

    if (loginBtn) {
        loginBtn.textContent = 'Dashboard';
        loginBtn.setAttribute('href', 'dashboard.html');
    }

    if (registerBtn) {
        registerBtn.textContent = 'Logout';
        registerBtn.setAttribute('href', '#');
        registerBtn.addEventListener('click', function(e) {
            e.preventDefault();
            localStorage.removeItem('user');
            localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
            window.location.href = 'index.html';
        });
    }
}

function forceUserLogout(message) {
    localStorage.removeItem('user');
    localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
    if (message) {
        alert(message);
    }
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    if (currentPage !== 'login.html' && currentPage !== 'register.html') {
        window.location.href = 'login.html';
    }
}

function initUserSessionGuard() {
    const userRaw = localStorage.getItem('user');
    if (!userRaw) return;

    let user;
    try {
        user = JSON.parse(userRaw);
    } catch (error) {
        localStorage.removeItem('user');
        localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
        return;
    }

    if (!user || !user.email) return;

    let checking = false;
    const checkSession = async () => {
        if (checking) return;
        checking = true;
        try {
            const response = await fetch('/api/user/session-status', {
                method: 'POST',
                headers: getUserAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ email: user.email })
            });

            if (!response.ok) {
                checking = false;
                return;
            }

            const data = await response.json();
            if (!data.valid) {
                const reason = data.reason === 'blocked'
                    ? 'Your account has been blocked by admin.'
                    : (data.reason === 'expired'
                        ? 'Your session expired. Please login again.'
                        : 'Your account was removed by admin.');
                forceUserLogout(reason);
                return;
            }
        } catch (error) {
            // Ignore transient network errors and keep current session state.
        } finally {
            checking = false;
        }
    };

    checkSession();
    const intervalId = window.setInterval(checkSession, 7000);
    window.addEventListener('beforeunload', () => clearInterval(intervalId));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkSession();
        }
    });
}

/**
 * Navbar scroll effect
 */
function initNavbar() {
    const header = document.querySelector('.header');
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');
    const navLinks = document.querySelectorAll('.nav-link');

    // Scroll effect
    if (header) {
        window.addEventListener('scroll', function() {
            if (window.scrollY > 50) {
                header.classList.add('scrolled');
            } else {
                header.classList.remove('scrolled');
            }
        });
    }

    // Mobile menu toggle
    if (hamburger) {
        hamburger.addEventListener('click', function() {
            hamburger.classList.toggle('active');
            navMenu.classList.toggle('active');
        });
    }

    // Close menu on link click
    navLinks.forEach(link => {
        link.addEventListener('click', function() {
            if (hamburger && navMenu) {
                hamburger.classList.remove('active');
                navMenu.classList.remove('active');
            }
        });
    });

    // Set active nav link based on current page
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage || (currentPage === '' && href === 'index.html')) {
            link.classList.add('active');
        }
    });
}

/**
 * Scroll animation for fade-in elements
 */
function initScrollAnimation() {
    const fadeElements = document.querySelectorAll('.fade-in');
    
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, observerOptions);

    fadeElements.forEach(element => {
        observer.observe(element);
    });
}

function initPremiumUX() {
    const canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isHomePage = document.body.classList.contains('home-page');

    const premiumCards = document.querySelectorAll(
        '.interactive-card, .feature-card, .course-card, .testimonial-card, .why-card, .journey-card, .dashboard-card'
    );
    const tiltCards = document.querySelectorAll(
        '.interactive-card, .feature-card, .course-card, .testimonial-card, .why-card, .journey-card'
    );
    premiumCards.forEach((card, idx) => {
        card.classList.add('premium-transition');
        if (idx % 2 === 0) {
            card.classList.add('glass-surface');
        }
    });

    const staggerItems = document.querySelectorAll('.fade-in');
    staggerItems.forEach((el, idx) => {
        if (prefersReducedMotion) return;
        el.style.transitionDelay = `${Math.min(idx * 35, 280)}ms`;
    });

    if (!canHover || prefersReducedMotion || isHomePage) return;
    tiltCards.forEach((card) => {
        card.classList.add('interactive-tilt');
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const relX = (e.clientX - rect.left) / rect.width;
            const relY = (e.clientY - rect.top) / rect.height;
            const rotateY = (relX - 0.5) * 8;
            const rotateX = (relY - 0.5) * -8;
            card.style.transform = `perspective(920px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
        });
        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
        });
    });
}

function initPersonalizedHomepage() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    if (page !== 'index.html') return;

    const userRaw = localStorage.getItem('user');
    if (!userRaw) return;

    let user;
    try {
        user = JSON.parse(userRaw);
    } catch (error) {
        return;
    }
    if (!user || !user.firstName) return;

    const firstName = String(user.firstName).trim();
    const heroBadge = document.querySelector('.hero-badge');
    const heroTitle = document.querySelector('.hero h1');
    const heroDescription = document.querySelector('.hero p');
    const loginBtn = document.querySelector('.btn-login');

    if (heroBadge) {
        heroBadge.innerHTML = `<i class="fas fa-sparkles"></i> Welcome back, ${firstName}`;
    }
    if (heroTitle) {
        const dynamic = heroTitle.querySelector('#dynamicHeadline');
        if (dynamic) {
            dynamic.textContent = `${firstName}'s Learning Journey`;
        }
    }
    if (heroDescription) {
        heroDescription.textContent = `${firstName}, continue your personalized training path and move one step closer to your career goal today.`;
    }
    if (loginBtn) {
        loginBtn.textContent = 'My Dashboard';
    }
}

function initHomeGeminiAssistant() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    if (page !== 'index.html') return;

    const form = document.getElementById('websiteAssistantForm');
    const input = document.getElementById('websiteAssistantInput');
    const answer = document.getElementById('websiteAssistantAnswer');
    const chips = document.querySelectorAll('[data-assistant-prompt]');
    const status = document.getElementById('websiteAssistantStatus');
    if (!form || !input || !answer) return;

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const setBusy = (busy) => {
        const submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = busy;
        input.disabled = busy;
        if (status) {
            status.textContent = busy ? 'Thinking...' : '';
        }
    };

    const renderSuggestions = (items = []) => {
        const host = document.getElementById('websiteAssistantSuggestions');
        if (!host) return;
        const list = Array.isArray(items) ? items.slice(0, 3).filter(Boolean) : [];
        if (!list.length) {
            host.innerHTML = '';
            return;
        }
        host.innerHTML = list.map(item => `
            <button type="button" class="assistant-suggestion" data-assistant-prompt="${escapeHtml(item)}">
                ${escapeHtml(item)}
            </button>
        `).join('');
        host.querySelectorAll('[data-assistant-prompt]').forEach(btn => {
            btn.addEventListener('click', () => {
                input.value = btn.getAttribute('data-assistant-prompt') || '';
                form.dispatchEvent(new Event('submit'));
            });
        });
    };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = input.value.trim();
        if (!message) return;

        setBusy(true);
        try {
            const response = await fetch('/api/website-assistant/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                answer.textContent = data.message || 'Unable to fetch answer right now.';
                renderSuggestions([]);
                return;
            }
            answer.textContent = data.answer || 'No answer available right now.';
            renderSuggestions(data.suggestions || []);
        } catch (error) {
            answer.textContent = 'Network error. Please try again.';
            renderSuggestions([]);
        } finally {
            setBusy(false);
        }
    });

    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            input.value = chip.getAttribute('data-assistant-prompt') || '';
            form.dispatchEvent(new Event('submit'));
        });
    });
}

function initCareerDnaMatcher() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    if (page !== 'index.html') return;

    const form = document.getElementById('careerDnaForm');
    const trackSelect = document.getElementById('dnaTrack');
    const levelSelect = document.getElementById('dnaLevel');
    const hoursInput = document.getElementById('dnaHours');
    const goalSelect = document.getElementById('dnaGoal');
    const output = document.getElementById('careerDnaOutput');
    const status = document.getElementById('careerDnaStatus');
    const submitBtn = document.getElementById('careerDnaBtn');
    const enrollBtn = document.getElementById('careerDnaEnrollBtn');
    if (!form || !trackSelect || !levelSelect || !hoursInput || !goalSelect || !output || !status || !submitBtn || !enrollBtn) return;

    const planStorageKey = 'tci-career-dna-plan';
    const state = {
        tracks: [],
        courses: []
    };

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const setBusy = (busy) => {
        submitBtn.disabled = busy;
        status.textContent = busy ? 'Building your personalized blueprint...' : '';
    };

    const trackKeywords = {
        'web-development': ['web', 'react', 'javascript', 'frontend', 'backend', 'full stack'],
        'python-programming': ['python', 'django', 'automation', 'data', 'api'],
        'data-science-ai': ['data', 'machine learning', 'ai', 'analytics', 'python'],
        'java-programming': ['java', 'spring', 'backend', 'sql']
    };

    const targetHoursByGoal = {
        job: 180,
        freelance: 150,
        promotion: 120,
        startup: 210
    };

    const levelFactor = {
        beginner: 1.35,
        intermediate: 1.0,
        advanced: 0.8
    };

    const goalFactor = {
        job: 1.0,
        freelance: 0.92,
        promotion: 0.85,
        startup: 1.1
    };

    const focusByGoal = {
        job: 'Project quality + interview readiness',
        freelance: 'Client delivery + communication',
        promotion: 'Advanced depth + leadership output',
        startup: 'Rapid build + product thinking'
    };

    function renderPlan(plan) {
        const topCourse = Array.isArray(plan.recommendedCourses) ? plan.recommendedCourses[0] : null;
        const topSlug = topCourse && topCourse.slug ? String(topCourse.slug).trim() : '';

        const coursesHtml = (plan.recommendedCourses || []).map(course => `
            <li>
                <strong>${escapeHtml(course.title || 'Course')}</strong><br>
                <span>${escapeHtml(course.duration || 'Flexible')} • ${escapeHtml(course.level || '')}</span>
            </li>
        `).join('');

        const sprintsHtml = (plan.sprints || []).map(item => `
            <li>${escapeHtml(item)}</li>
        `).join('');

        output.innerHTML = `
            <div class="dna-panel">
                <div class="dna-title">Your Career DNA Summary</div>
                <div class="dna-summary">${escapeHtml(plan.summary || '')}</div>
                <ul class="dna-list">${sprintsHtml}</ul>
            </div>
            <div class="dna-panel">
                <div class="dna-title">Recommended Course Sequence</div>
                <ul class="dna-list">${coursesHtml || '<li>No mapped course found. Explore all courses.</li>'}</ul>
            </div>
        `;

        if (topSlug) {
            enrollBtn.disabled = false;
            enrollBtn.setAttribute('data-course-slug', topSlug);
            enrollBtn.innerHTML = '<i class="fas fa-rocket"></i> Enroll Recommended Path';
        } else {
            enrollBtn.disabled = true;
            enrollBtn.setAttribute('data-course-slug', '');
            enrollBtn.innerHTML = '<i class="fas fa-compass"></i> Explore Courses';
        }
    }

    function buildPlan() {
        const trackId = trackSelect.value;
        const level = levelSelect.value || 'beginner';
        const goal = goalSelect.value || 'job';
        const weeklyHoursRaw = Number(hoursInput.value);
        const weeklyHours = Number.isFinite(weeklyHoursRaw) ? Math.min(30, Math.max(2, weeklyHoursRaw)) : 8;
        hoursInput.value = String(weeklyHours);

        const track = state.tracks.find(item => item.id === trackId);
        if (!track) {
            status.textContent = 'Please choose a target track.';
            return;
        }

        const baseHours = targetHoursByGoal[goal] || 160;
        const estHours = Math.round(baseHours * (levelFactor[level] || 1) * (goalFactor[goal] || 1));
        const estWeeks = Math.max(4, Math.round(estHours / Math.max(2, weeklyHours)));
        const estMonths = (estWeeks / 4.3).toFixed(1);

        const keywords = trackKeywords[track.id] || String(track.title || '').toLowerCase().split(/\s+/);
        const recommendedCourses = state.courses
            .filter(course => {
                const blob = `${course.title} ${course.description} ${course.level}`.toLowerCase();
                return keywords.some(k => blob.includes(String(k).toLowerCase()));
            })
            .slice(0, 3);

        const plan = {
            trackId: track.id,
            trackTitle: track.title,
            summary: `For ${track.title}, at ${weeklyHours}h/week and ${level} level, you can target job-ready outcomes in about ${estWeeks} weeks (~${estMonths} months). Focus area: ${focusByGoal[goal] || 'Consistent practical execution'}.`,
            recommendedCourses,
            sprints: [
                `Sprint 1 (Week 1-${Math.max(2, Math.round(estWeeks * 0.3))}): Foundations + daily concept drills`,
                `Sprint 2 (Week ${Math.max(3, Math.round(estWeeks * 0.3) + 1)}-${Math.max(4, Math.round(estWeeks * 0.7))}): Project implementation + mentorship reviews`,
                `Sprint 3 (Final ${Math.max(2, Math.round(estWeeks * 0.3))} weeks): Portfolio polishing + interview simulation`
            ],
            createdAt: new Date().toISOString()
        };

        localStorage.setItem(planStorageKey, JSON.stringify(plan));
        renderPlan(plan);
        status.textContent = `Blueprint ready for ${track.title}. Saved on this device.`;
    }

    async function bootstrap() {
        setBusy(true);
        try {
            const [tracksRes, coursesRes] = await Promise.all([
                fetch('/api/skill-analyzer/tracks'),
                fetch('/api/courses')
            ]);
            const tracksData = await tracksRes.json();
            const coursesData = await coursesRes.json();

            state.tracks = tracksData?.success && Array.isArray(tracksData.tracks)
                ? tracksData.tracks
                : [];
            state.courses = Array.isArray(coursesData) ? coursesData : [];

            trackSelect.innerHTML = '<option value="">Choose your target track</option>' +
                state.tracks.map(track => `<option value="${escapeHtml(track.id)}">${escapeHtml(track.title)}</option>`).join('');

            const savedRaw = localStorage.getItem(planStorageKey);
            if (savedRaw) {
                try {
                    const saved = JSON.parse(savedRaw);
                    if (saved && saved.trackId) {
                        trackSelect.value = saved.trackId;
                        renderPlan(saved);
                        status.textContent = `Loaded your last blueprint for ${saved.trackTitle || 'selected track'}.`;
                    }
                } catch (error) {
                    localStorage.removeItem(planStorageKey);
                }
            } else {
                output.innerHTML = `
                    <div class="dna-panel">
                        <div class="dna-title">No Blueprint Yet</div>
                        <div class="dna-summary">Select your track and click "Generate My Blueprint" to get a personalized roadmap and course sequence.</div>
                    </div>
                `;
                enrollBtn.disabled = true;
                enrollBtn.setAttribute('data-course-slug', '');
            }
        } catch (error) {
            status.textContent = 'Unable to load matcher data right now.';
        } finally {
            setBusy(false);
        }
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        buildPlan();
    });

    enrollBtn.addEventListener('click', () => {
        const slug = String(enrollBtn.getAttribute('data-course-slug') || '').trim();
        if (slug) {
            window.location.href = `course-details.html?course=${encodeURIComponent(slug)}`;
            return;
        }
        window.location.href = 'courses.html';
    });

    bootstrap();
}

/**
 * Contact form handling
 */
function initContactForm() {
    const contactForm = document.getElementById('contactForm');
    
    if (contactForm) {
        contactForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const submitBtn = contactForm.querySelector('button[type="submit"]');
            const originalText = submitBtn.textContent;
            const formSuccess = document.querySelector('.form-success');
            
            // Get form data
            const formData = {
                name: document.getElementById('name').value,
                email: document.getElementById('email').value,
                phone: document.getElementById('phone').value,
                course: document.getElementById('course') ? document.getElementById('course').value : '',
                message: document.getElementById('message') ? document.getElementById('message').value : ''
            };
            
            // Show loading state
            submitBtn.textContent = 'Sending...';
            submitBtn.disabled = true;
            
            try {
                const response = await fetch('/api/contact', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(formData)
                });
                
                const data = await response.json();
                
                if (data.success) {
                    // Show success message
                    formSuccess.textContent = data.message;
                    formSuccess.style.display = 'block';
                    contactForm.reset();
                    
                    // Hide success message after 5 seconds
                    setTimeout(() => {
                        formSuccess.style.display = 'none';
                    }, 5000);
                } else {
                    alert(data.message || 'Something went wrong. Please try again.');
                }
            } catch (error) {
                console.error('Error:', error);
                alert('Network error. Please try again later.');
            } finally {
                // Reset button
                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
            }
        });
    }
}

/**
 * Load courses dynamically (for courses page)
 */
async function initCourseCards() {
    const coursesGrid = document.getElementById('coursesGrid');
    
    if (coursesGrid) {
        try {
            const response = await fetch('/api/courses');
            const courses = await response.json();
            const page = window.location.pathname.split('/').pop() || 'index.html';
            const displayCourses = page === 'index.html' ? courses.slice(0, 6) : courses;

            coursesGrid.innerHTML = displayCourses.map(course => createCourseCard(course)).join('');
            observeNewFadeElements();
            applyCourseFilter();
        } catch (error) {
            console.error('Error loading courses:', error);
            coursesGrid.innerHTML = '<p class="error">Failed to load courses. Please try again later.</p>';
        }
    }
}

/**
 * Filter homepage courses by search query
 */
function applyCourseFilter() {
    const input = document.getElementById('courseSearchInput');
    const cards = document.querySelectorAll('#coursesGrid .course-card');
    const resultLabel = document.getElementById('courseSearchResult');
    if (!cards.length || !resultLabel) return;

    const query = input ? input.value.trim().toLowerCase() : '';
    let visibleCount = 0;

    cards.forEach(card => {
        const searchable = card.getAttribute('data-search') || '';
        const visible = !query || searchable.includes(query);
        card.style.display = visible ? '' : 'none';
        if (visible) visibleCount += 1;
    });

    if (!query) {
        resultLabel.textContent = `Showing ${visibleCount} courses`;
    } else {
        resultLabel.textContent = visibleCount > 0
            ? `${visibleCount} course${visibleCount > 1 ? 's' : ''} found`
            : 'No course matched your search';
    }
}

function initCourseFinder() {
    const input = document.getElementById('courseSearchInput');
    const clearBtn = document.getElementById('courseSearchClear');

    if (input) {
        input.addEventListener('input', applyCourseFilter);
    }

    if (clearBtn && input) {
        clearBtn.addEventListener('click', () => {
            input.value = '';
            applyCourseFilter();
            input.focus();
        });
    }
}

/**
 * Ensure dynamically inserted fade-in elements are observed
 */
function observeNewFadeElements() {
    const fadeElements = document.querySelectorAll('.fade-in:not(.visible)');
    if (fadeElements.length === 0) return;

    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    fadeElements.forEach(element => observer.observe(element));
}

/**
 * Create course card HTML
 */
function createCourseCard(course) {
    const priceLabel = course.priceLabel || (Number.isFinite(Number(course.price)) ? `INR ${Math.round(Number(course.price))}` : 'Price on request');
    const searchText = `${course.title} ${course.description} ${course.duration} ${course.level} ${priceLabel}`
        .toLowerCase()
        .replace(/"/g, '&quot;');
    const detailLink = `course-details.html?course=${encodeURIComponent(course.slug || course.id)}`;
    return `
        <div class="course-card fade-in interactive-card" data-search="${searchText}">
            <div class="course-image">
                <img src="${course.image}" alt="${course.title}">
                <span class="course-badge">${course.duration}</span>
            </div>
            <div class="course-content">
                <div class="course-icon">
                    <i class="${course.icon}"></i>
                </div>
                <h4>${course.title}</h4>
                <p>${course.description}</p>
                <div class="course-meta">
                    <span><i class="fas fa-clock"></i> ${course.duration}</span>
                    <span><i class="fas fa-signal"></i> ${course.level}</span>
                </div>
                <div class="course-price"><i class="fas fa-tag"></i> ${priceLabel}</div>
                <a class="course-detail-link" href="${detailLink}">
                    View Full Syllabus <i class="fas fa-arrow-right"></i>
                </a>
            </div>
        </div>
    `;
}

/**
 * FAQ accordion interaction
 */
function initFaqAccordion() {
    const items = document.querySelectorAll('.faq-item');
    if (!items.length) return;

    items.forEach(item => {
        const question = item.querySelector('.faq-question');
        if (!question) return;
        question.addEventListener('click', () => {
            const isOpen = item.classList.contains('active');
            items.forEach(i => i.classList.remove('active'));
            if (!isOpen) item.classList.add('active');
        });
    });
}

/**
 * Floating back-to-top button
 */
function initBackToTop() {
    let btn = document.getElementById('backToTopBtn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'backToTopBtn';
        btn.className = 'back-to-top-btn';
        btn.setAttribute('aria-label', 'Back to top');
        btn.innerHTML = '<i class="fas fa-chevron-up"></i>';
        document.body.appendChild(btn);
    }

    const toggleBtn = () => {
        if (window.scrollY > 320) {
            btn.classList.add('visible');
        } else {
            btn.classList.remove('visible');
        }
    };

    window.addEventListener('scroll', toggleBtn);
    toggleBtn();

    btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

/**
 * Gallery lightbox effect
 */
function initGallery() {
    const galleryItems = document.querySelectorAll('.gallery-item');
    
    galleryItems.forEach(item => {
        item.addEventListener('click', function() {
            const imgSrc = this.querySelector('img').src;
            openLightbox(imgSrc);
        });
    });
    
    // Close lightbox on escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeLightbox();
        }
    });
}

/**
 * Open lightbox
 */
function openLightbox(src) {
    const lightbox = document.createElement('div');
    lightbox.id = 'lightbox';
    lightbox.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        cursor: pointer;
    `;
    
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = `
        max-width: 90%;
        max-height: 90%;
        border-radius: 10px;
        box-shadow: 0 0 30px rgba(0, 0, 0, 0.5);
    `;
    
    lightbox.appendChild(img);
    document.body.appendChild(lightbox);
    
    lightbox.addEventListener('click', closeLightbox);
}

/**
 * Close lightbox
 */
function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    if (lightbox) {
        lightbox.remove();
    }
}

/**
 * Counter animation for statistics
 */
function initCounterAnimation() {
    const counters = document.querySelectorAll('.stat-number');
    
    if (counters.length > 0) {
        const observerOptions = {
            threshold: 0.5
        };
        
        const observer = new IntersectionObserver(function(entries) {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const counter = entry.target;
                    const target = parseInt(counter.getAttribute('data-target'));
                    animateCounter(counter, target);
                    observer.unobserve(counter);
                }
            });
        }, observerOptions);
        
        counters.forEach(counter => {
            observer.observe(counter);
        });
    }
}

/**
 * Animate counter from 0 to target
 */
function animateCounter(element, target) {
    let current = 0;
    const increment = target / 50;
    const duration = 1500;
    const stepTime = duration / 50;
    
    const timer = setInterval(function() {
        current += increment;
        if (current >= target) {
            element.textContent = target + '+';
            clearInterval(timer);
        } else {
            element.textContent = Math.floor(current) + '+';
        }
    }, stepTime);
}

/**
 * Smooth scroll for anchor links
 */
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const href = this.getAttribute('href');

        // Ignore placeholder/hash-only links to avoid invalid selector errors.
        if (!href || href === '#') {
            return;
        }

        const targetId = href.slice(1);
        const target = document.getElementById(targetId);

        if (target) {
            e.preventDefault();
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

/**
 * Add loading animation to images
 */
document.querySelectorAll('img').forEach(img => {
    img.addEventListener('load', function() {
        this.classList.add('loaded');
    });
    
    if (img.complete) {
        img.classList.add('loaded');
    }
});
