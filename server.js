const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');
const os = require('os');

function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;

    try {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex <= 0) continue;

            const key = trimmed.slice(0, separatorIndex).trim();
            let value = trimmed.slice(separatorIndex + 1).trim();

            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
                process.env[key] = value;
            }
        }
    } catch (error) {
        console.error('Failed to load .env file:', error.message);
    }
}

loadEnvFile();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    return res.json({
        success: true,
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// Local JSON persistence
const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, 'data');
const inquiriesFile = path.join(dataDir, 'inquiries.json');
const usersFile = path.join(dataDir, 'users.json');
const announcementFile = path.join(dataDir, 'announcement.json');
const gamificationConfigFile = path.join(dataDir, 'gamification.json');
const coursePricingFile = path.join(dataDir, 'course-pricing.json');

function ensureDataDir() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function loadData(filePath, fallback = []) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.error(`Failed to read ${filePath}:`, error.message);
        return fallback;
    }
}

function saveData(filePath, data) {
    try {
        ensureDataDir();
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Failed to write ${filePath}:`, error.message);
    }
}

ensureDataDir();

// Persistent storage for inquiries and users
const inquiries = loadData(inquiriesFile, []);
const users = loadData(usersFile, []);
const announcementState = loadData(announcementFile, {
    title: '',
    message: '',
    type: 'info',
    active: false,
    ctaText: '',
    ctaUrl: '',
    startsAt: '',
    endsAt: '',
    dismissible: true,
    updatedAt: null
});
function normalizeCoursePricing(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const normalized = {};
    Object.keys(source).forEach((key) => {
        const slug = String(key || '').trim().toLowerCase();
        if (!slug) return;
        const value = Number(source[key]);
        if (!Number.isFinite(value) || value <= 0) return;
        normalized[slug] = Math.round(value);
    });
    return normalized;
}

let coursePricingOverrides = normalizeCoursePricing(loadData(coursePricingFile, {}));
saveData(coursePricingFile, coursePricingOverrides);
const adminSessions = new Map();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || process.env.GOOGLE_GEMINI_MODEL || 'gemini-1.5-flash';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const GEMINI_FALLBACK_MODELS = [
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest',
    'gemini-2.0-flash'
];

const DEFAULT_GAMIFICATION_CONFIG = {
    xpPerLevel: 250,
    rewards: {
        enrollXp: 120,
        topicXp: 8,
        completionXp: 80,
        dailyBaseXp: 10,
        dailyStreakFactor: 2,
        dailyStreakCap: 20
    },
    weeklyChallenge: {
        targetTopics: 10,
        rewardXp: 120,
        label: 'Weekly Sprint'
    }
};

function normalizeGamificationConfig(config = {}) {
    const source = config && typeof config === 'object' ? config : {};
    const rewards = source.rewards && typeof source.rewards === 'object' ? source.rewards : {};
    const weekly = source.weeklyChallenge && typeof source.weeklyChallenge === 'object' ? source.weeklyChallenge : {};
    return {
        xpPerLevel: Math.max(50, Number(source.xpPerLevel) || DEFAULT_GAMIFICATION_CONFIG.xpPerLevel),
        rewards: {
            enrollXp: Math.max(0, Number(rewards.enrollXp) || DEFAULT_GAMIFICATION_CONFIG.rewards.enrollXp),
            topicXp: Math.max(0, Number(rewards.topicXp) || DEFAULT_GAMIFICATION_CONFIG.rewards.topicXp),
            completionXp: Math.max(0, Number(rewards.completionXp) || DEFAULT_GAMIFICATION_CONFIG.rewards.completionXp),
            dailyBaseXp: Math.max(0, Number(rewards.dailyBaseXp) || DEFAULT_GAMIFICATION_CONFIG.rewards.dailyBaseXp),
            dailyStreakFactor: Math.max(0, Number(rewards.dailyStreakFactor) || DEFAULT_GAMIFICATION_CONFIG.rewards.dailyStreakFactor),
            dailyStreakCap: Math.max(0, Number(rewards.dailyStreakCap) || DEFAULT_GAMIFICATION_CONFIG.rewards.dailyStreakCap)
        },
        weeklyChallenge: {
            targetTopics: Math.max(1, Number(weekly.targetTopics) || DEFAULT_GAMIFICATION_CONFIG.weeklyChallenge.targetTopics),
            rewardXp: Math.max(0, Number(weekly.rewardXp) || DEFAULT_GAMIFICATION_CONFIG.weeklyChallenge.rewardXp),
            label: String(weekly.label || DEFAULT_GAMIFICATION_CONFIG.weeklyChallenge.label).trim().slice(0, 80) || DEFAULT_GAMIFICATION_CONFIG.weeklyChallenge.label
        }
    };
}

let gamificationConfig = normalizeGamificationConfig(loadData(gamificationConfigFile, DEFAULT_GAMIFICATION_CONFIG));
saveData(gamificationConfigFile, gamificationConfig);

const GAMIFICATION_BADGES = [
    { id: 'first-enroll', label: 'First Step', icon: 'fa-seedling', description: 'Enroll in your first course.' },
    { id: 'three-courses', label: 'Multi Learner', icon: 'fa-layer-group', description: 'Enroll in 3 or more courses.' },
    { id: 'xp-100', label: 'Rising Star', icon: 'fa-star', description: 'Reach 100 XP.' },
    { id: 'xp-500', label: 'XP Warrior', icon: 'fa-bolt', description: 'Reach 500 XP.' },
    { id: 'streak-3', label: 'Consistency 3', icon: 'fa-fire', description: 'Maintain a 3-day streak.' },
    { id: 'streak-7', label: 'Consistency 7', icon: 'fa-fire-flame-curved', description: 'Maintain a 7-day streak.' },
    { id: 'course-master', label: 'Course Master', icon: 'fa-medal', description: 'Reach 100% in any enrolled course.' }
];

function getBearerToken(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    return authHeader.slice('Bearer '.length).trim();
}

function requireAdminAuth(req, res, next) {
    const token = getBearerToken(req);
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized. Admin login required.'
        });
    }
    next();
}

function normalizeAnnouncement(payload = {}) {
    const allowedTypes = new Set(['info', 'success', 'warning']);
    const type = allowedTypes.has(payload.type) ? payload.type : 'info';
    const parseDateInput = (value) => {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toISOString();
    };
    const startsAt = parseDateInput(payload.startsAt);
    let endsAt = parseDateInput(payload.endsAt);
    if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) {
        endsAt = '';
    }
    const ctaText = typeof payload.ctaText === 'string' ? payload.ctaText.trim().slice(0, 40) : '';
    const ctaUrl = typeof payload.ctaUrl === 'string' ? payload.ctaUrl.trim().slice(0, 240) : '';

    return {
        title: typeof payload.title === 'string' ? payload.title.trim().slice(0, 80) : '',
        message: typeof payload.message === 'string' ? payload.message.trim().slice(0, 220) : '',
        type,
        active: Boolean(payload.active),
        ctaText,
        ctaUrl,
        startsAt,
        endsAt,
        dismissible: payload.dismissible !== false,
        updatedAt: new Date().toISOString()
    };
}

function isAnnouncementLive(announcement = {}) {
    if (!announcement.active || !announcement.message) return false;
    const now = new Date();
    if (announcement.startsAt) {
        const start = new Date(announcement.startsAt);
        if (!Number.isNaN(start.getTime()) && now < start) return false;
    }
    if (announcement.endsAt) {
        const end = new Date(announcement.endsAt);
        if (!Number.isNaN(end.getTime()) && now > end) return false;
    }
    return true;
}

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getWeekKey(dateValue = new Date()) {
    const date = new Date(dateValue);
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function levelFromXp(xp) {
    const normalizedXp = Number.isFinite(Number(xp)) ? Math.max(0, Number(xp)) : 0;
    return Math.floor(normalizedXp / gamificationConfig.xpPerLevel) + 1;
}

function levelBounds(level) {
    const currentLevel = Math.max(1, Number(level) || 1);
    const minXp = (currentLevel - 1) * gamificationConfig.xpPerLevel;
    const maxXp = currentLevel * gamificationConfig.xpPerLevel;
    return { minXp, maxXp };
}

function normalizeGamification(state = {}) {
    const xp = Math.max(0, Number(state.xp) || 0);
    const level = levelFromXp(xp);
    const badges = Array.isArray(state.badges)
        ? [...new Set(state.badges.map(item => String(item || '').trim()).filter(Boolean))]
        : [];
    const weeklySource = state.weeklyProgress && typeof state.weeklyProgress === 'object' ? state.weeklyProgress : {};
    const progressByCourse = (state.progressByCourse && typeof state.progressByCourse === 'object')
        ? state.progressByCourse
        : {};
    const normalizedProgress = {};

    Object.keys(progressByCourse).forEach(slug => {
        const key = String(slug || '').trim();
        if (!key) return;
        const item = progressByCourse[slug] || {};
        normalizedProgress[key] = {
            courseSlug: key,
            courseTitle: String(item.courseTitle || '').trim(),
            completedCount: Math.max(0, Number(item.completedCount) || 0),
            totalTopics: Math.max(0, Number(item.totalTopics) || 0),
            percent: Math.min(100, Math.max(0, Number(item.percent) || 0)),
            updatedAt: item.updatedAt || ''
        };
    });

    return {
        xp,
        level,
        badges,
        streakCurrent: Math.max(0, Number(state.streakCurrent) || 0),
        streakLongest: Math.max(0, Number(state.streakLongest) || 0),
        lastActiveDate: String(state.lastActiveDate || ''),
        weeklyProgress: {
            weekKey: String(weeklySource.weekKey || getWeekKey()),
            topicsCompleted: Math.max(0, Number(weeklySource.topicsCompleted) || 0),
            rewardClaimed: Boolean(weeklySource.rewardClaimed),
            rewardXp: Math.max(0, Number(weeklySource.rewardXp) || 0)
        },
        progressByCourse: normalizedProgress
    };
}

function ensureGamification(user = {}) {
    user.gamification = normalizeGamification(user.gamification || {});
    return user.gamification;
}

function addXp(user, amount) {
    const xpGain = Math.max(0, Number(amount) || 0);
    if (!xpGain) return 0;
    const gamification = ensureGamification(user);
    gamification.xp += xpGain;
    gamification.level = levelFromXp(gamification.xp);
    return xpGain;
}

function touchDailyStreak(user) {
    const gamification = ensureGamification(user);
    const today = getTodayKey();
    const lastDay = String(gamification.lastActiveDate || '');
    if (lastDay === today) {
        return 0;
    }

    let nextStreak = 1;
    if (lastDay) {
        const prev = new Date(`${lastDay}T00:00:00Z`).getTime();
        const now = new Date(`${today}T00:00:00Z`).getTime();
        const diffDays = Number.isFinite(prev) ? Math.round((now - prev) / (24 * 60 * 60 * 1000)) : 0;
        if (diffDays === 1) {
            nextStreak = Math.max(1, gamification.streakCurrent + 1);
        }
    }

    gamification.streakCurrent = nextStreak;
    gamification.streakLongest = Math.max(gamification.streakLongest, nextStreak);
    gamification.lastActiveDate = today;

    const streakBonus = Math.min(
        gamificationConfig.rewards.dailyStreakCap,
        nextStreak * gamificationConfig.rewards.dailyStreakFactor
    );
    return addXp(user, gamificationConfig.rewards.dailyBaseXp + streakBonus);
}

function applyWeeklyChallenge(user, topicDelta = 0) {
    const gamification = ensureGamification(user);
    const weekKey = getWeekKey();
    if (gamification.weeklyProgress.weekKey !== weekKey) {
        gamification.weeklyProgress = {
            weekKey,
            topicsCompleted: 0,
            rewardClaimed: false,
            rewardXp: 0
        };
    }

    const delta = Math.max(0, Number(topicDelta) || 0);
    if (delta > 0) {
        gamification.weeklyProgress.topicsCompleted += delta;
    }

    const target = gamificationConfig.weeklyChallenge.targetTopics;
    if (!gamification.weeklyProgress.rewardClaimed && gamification.weeklyProgress.topicsCompleted >= target) {
        const reward = addXp(user, gamificationConfig.weeklyChallenge.rewardXp);
        gamification.weeklyProgress.rewardClaimed = true;
        gamification.weeklyProgress.rewardXp = reward;
        return reward;
    }
    return 0;
}

function applyBadges(user = {}) {
    const gamification = ensureGamification(user);
    const unlocked = new Set(gamification.badges || []);
    const enrolledCount = Array.isArray(user.enrolledCourses) ? user.enrolledCourses.length : 0;
    const hasCourseMaster = Object.values(gamification.progressByCourse || {}).some(item => (item.percent || 0) >= 100);

    if (enrolledCount >= 1) unlocked.add('first-enroll');
    if (enrolledCount >= 3) unlocked.add('three-courses');
    if (gamification.xp >= 100) unlocked.add('xp-100');
    if (gamification.xp >= 500) unlocked.add('xp-500');
    if (gamification.streakCurrent >= 3) unlocked.add('streak-3');
    if (gamification.streakCurrent >= 7) unlocked.add('streak-7');
    if (hasCourseMaster) unlocked.add('course-master');

    gamification.badges = [...unlocked];
    gamification.level = levelFromXp(gamification.xp);
    return gamification.badges;
}

function getBadgeDetails(user = {}) {
    const gamification = ensureGamification(user);
    const unlocked = new Set(gamification.badges || []);
    return GAMIFICATION_BADGES.map(badge => ({
        ...badge,
        unlocked: unlocked.has(badge.id)
    }));
}

function getGamificationSummary(user = {}) {
    const gamification = ensureGamification(user);
    const level = gamification.level || 1;
    const bounds = levelBounds(level);
    const levelProgressPercent = Math.min(100, Math.max(0, Math.round(((gamification.xp - bounds.minXp) / gamificationConfig.xpPerLevel) * 100)));
    const weekKey = getWeekKey();
    const weekly = gamification.weeklyProgress && gamification.weeklyProgress.weekKey === weekKey
        ? gamification.weeklyProgress
        : { weekKey, topicsCompleted: 0, rewardClaimed: false, rewardXp: 0 };
    return {
        xp: gamification.xp,
        level,
        levelProgressPercent,
        nextLevelXp: bounds.maxXp,
        streakCurrent: gamification.streakCurrent,
        streakLongest: gamification.streakLongest,
        weeklyChallenge: {
            label: gamificationConfig.weeklyChallenge.label,
            targetTopics: gamificationConfig.weeklyChallenge.targetTopics,
            rewardXp: gamificationConfig.weeklyChallenge.rewardXp,
            weekKey,
            topicsCompleted: weekly.topicsCompleted,
            rewardClaimed: Boolean(weekly.rewardClaimed),
            progressPercent: Math.min(100, Math.round((weekly.topicsCompleted / Math.max(1, gamificationConfig.weeklyChallenge.targetTopics)) * 100))
        },
        badges: getBadgeDetails(user),
        unlockedBadgeCount: (gamification.badges || []).length
    };
}

function computeRankForEmail(email = '') {
    const targetEmail = String(email || '').trim().toLowerCase();
    if (!targetEmail) {
        return { rank: 0, totalStudents: 0 };
    }

    const ranked = users
        .map(user => normalizeUserEnrollment(user))
        .map(user => {
            const g = ensureGamification(user);
            return {
                email: String(user.email || '').trim().toLowerCase(),
                xp: g.xp,
                streak: g.streakCurrent
            };
        })
        .sort((a, b) => (b.xp - a.xp) || (b.streak - a.streak) || a.email.localeCompare(b.email));

    const idx = ranked.findIndex(item => item.email === targetEmail);
    return {
        rankAmongStudents: idx >= 0 ? (idx + 1) : 0,
        totalStudents: ranked.length
    };
}

function getCareerRoleByCourse(courseTitle = '') {
    const title = String(courseTitle || '').toLowerCase();
    if (title.includes('python') || title.includes('data science') || title.includes('machine learning')) return 'Data Analyst';
    if (title.includes('web') || title.includes('react') || title.includes('javascript') || title.includes('angular')) return 'Full Stack Developer';
    if (title.includes('java')) return 'Java Backend Developer';
    if (title.includes('cloud') || title.includes('devops')) return 'Cloud Engineer';
    if (title.includes('cyber')) return 'Security Analyst';
    if (title.includes('ui/ux') || title.includes('design')) return 'UI/UX Designer';
    return 'Tech Professional';
}

function getNextTopicForUser(user = {}) {
    const normalizedUser = normalizeUserEnrollment(user);
    const enrolled = Array.isArray(normalizedUser.enrolledCourses) ? normalizedUser.enrolledCourses : [];
    if (!enrolled.length) {
        return {
            courseTitle: '',
            nextTopic: 'Explore one course and enroll to start your guided plan',
            completionPercent: 0
        };
    }

    let best = null;
    for (const item of enrolled) {
        const course = getCourseByIdentifier(item.slug);
        if (!course || !Array.isArray(course.topics) || !course.topics.length) continue;
        const g = ensureGamification(normalizedUser);
        const progress = g.progressByCourse[item.slug] || {};
        const completedCount = Math.max(0, Number(progress.completedCount) || 0);
        const percent = Math.min(100, Math.round((completedCount / course.topics.length) * 100));
        const nextTopic = course.topics[Math.min(completedCount, course.topics.length - 1)];

        const candidate = {
            courseTitle: course.title,
            nextTopic,
            completionPercent: percent
        };

        if (!best) {
            best = candidate;
            continue;
        }

        // Prefer the least completed course first to keep learning balanced.
        if (candidate.completionPercent < best.completionPercent) {
            best = candidate;
        }
    }

    return best || {
        courseTitle: enrolled[0].title || '',
        nextTopic: `Continue with ${enrolled[0].title || 'your course'} today`,
        completionPercent: 0
    };
}

function buildMentorMessage(user = {}) {
    const normalizedUser = normalizeUserEnrollment(user);
    const firstName = String(normalizedUser.firstName || 'Student').trim() || 'Student';
    const focus = getNextTopicForUser(normalizedUser);
    const role = getCareerRoleByCourse(focus.courseTitle || normalizedUser.course || '');
    const completionText = Number.isFinite(Number(focus.completionPercent)) ? `${focus.completionPercent}%` : '0%';
    return {
        greeting: `Hi ${firstName}, I am your AI Mentor.`,
        mainMessage: `${firstName}, complete ${focus.nextTopic} today to stay on track for ${role} role.`,
        nextStudy: focus.nextTopic,
        recommendedRole: role,
        courseTitle: focus.courseTitle || normalizedUser.course || 'Learning Track',
        completionPercent: completionText
    };
}

function getOrCreateDailyMentorReminder(user = {}) {
    const today = getTodayKey();
    const normalizedUser = normalizeUserEnrollment(user);
    const current = normalizedUser.aiMentor && typeof normalizedUser.aiMentor === 'object'
        ? normalizedUser.aiMentor
        : {};

    if (current.lastReminderDate === today && current.message) {
        return {
            message: current.message,
            generatedAt: current.generatedAt || new Date().toISOString()
        };
    }

    const mentor = buildMentorMessage(normalizedUser);
    const reminder = {
        lastReminderDate: today,
        message: mentor.mainMessage,
        generatedAt: new Date().toISOString()
    };

    normalizedUser.aiMentor = reminder;
    Object.assign(user, normalizedUser);
    return {
        message: reminder.message,
        generatedAt: reminder.generatedAt
    };
}

function generateMentorChatReply(user = {}, message = '') {
    const normalizedUser = normalizeUserEnrollment(user);
    const text = String(message || '').trim();
    const question = text.toLowerCase();
    const mentor = buildMentorMessage(normalizedUser);
    const weekly = getGamificationSummary(normalizedUser).weeklyChallenge || { topicsCompleted: 0, targetTopics: 0 };
    const weakAreas = Array.isArray(normalizedUser.skillAnalyzer?.weakAreas)
        ? normalizedUser.skillAnalyzer.weakAreas
        : [];

    let reply = '';
    let suggestions = [];

    if (/(next|study|learn|what should i|what to do)/i.test(question)) {
        reply = `Great question. Your next best move is: ${mentor.nextStudy}. Complete this first, then spend 20 minutes revising your previous topic to improve retention.`;
        suggestions = [
            'Give me a 60-minute study plan',
            'What are my weak areas?',
            'How close am I to my career goal?'
        ];
    } else if (/(weak|difficult|struggle|problem area)/i.test(question)) {
        if (weakAreas.length) {
            reply = `Your current weak areas are ${weakAreas.join(', ')}. Focus on one weak area per day: learn concept (20m), practice (25m), and self-quiz (15m).`;
        } else {
            reply = 'No major weak area is flagged yet. Keep consistency and challenge yourself with harder practice sets this week.';
        }
        suggestions = [
            'Create a weekly improvement plan',
            'What topic should I finish today?'
        ];
    } else if (/(career|job|role|placement)/i.test(question)) {
        reply = `You are currently on track for ${mentor.recommendedRole}. To become job-ready faster, keep course completion above 70% and build 2 project case studies from your current track.`;
        suggestions = [
            'Suggest project ideas for my role',
            'What should I complete this week?'
        ];
    } else if (/(schedule|plan|today|daily|time)/i.test(question)) {
        reply = `Today's smart plan: 1) 20 min concept review, 2) 30 min hands-on on "${mentor.nextStudy}", 3) 10 min recap notes. This keeps you on track and improves long-term retention.`;
        suggestions = [
            'Remind me tomorrow as well',
            'What is my weekly challenge progress?'
        ];
    } else if (/(week|weekly challenge|streak)/i.test(question)) {
        reply = `Your weekly challenge progress is ${weekly.topicsCompleted || 0}/${weekly.targetTopics || 0} topics. Finish 2 focused topics today to build momentum and protect your streak.`;
        suggestions = [
            'What should I study next?',
            'Give me a short revision plan'
        ];
    } else {
        reply = `${mentor.mainMessage} If you want, I can also create a daily study plan, identify weak areas, or map your next steps for ${mentor.recommendedRole}.`;
        suggestions = [
            'What should I study next?',
            'Show my weak areas',
            'Create daily plan'
        ];
    }

    return { reply, suggestions };
}

function buildMentorContext(user = {}) {
    const normalizedUser = normalizeUserEnrollment(user);
    const mentor = buildMentorMessage(normalizedUser);
    const gamification = getGamificationSummary(normalizedUser);
    const skill = normalizedUser.skillAnalyzer || {};
    const weakAreas = Array.isArray(skill.weakAreas) ? skill.weakAreas : [];
    const enrolled = Array.isArray(normalizedUser.enrolledCourses) ? normalizedUser.enrolledCourses : [];

    return {
        studentName: `${normalizedUser.firstName || ''} ${normalizedUser.lastName || ''}`.trim() || 'Student',
        email: normalizedUser.email || '',
        currentCourse: mentor.courseTitle || normalizedUser.course || '',
        nextStudy: mentor.nextStudy || '',
        recommendedRole: mentor.recommendedRole || '',
        completionPercent: mentor.completionPercent || '0%',
        weeklyChallenge: gamification.weeklyChallenge || {},
        streakCurrent: gamification.streakCurrent || 0,
        weakAreas,
        enrolledCourses: enrolled.map(item => item.title)
    };
}

async function getChatGptMentorReply(user = {}, message = '') {
    if (!OPENAI_API_KEY) return null;
    const context = buildMentorContext(user);
    const fallback = generateMentorChatReply(user, message);

    const systemPrompt = [
        'You are an AI Personal Mentor for a computer training institute dashboard.',
        'Speak like a practical teacher: concise, supportive, direct, and action-oriented.',
        'Always personalize using the student context below.',
        'Return valid JSON only with keys: reply, suggestions.',
        'reply: 1 short paragraph.',
        'suggestions: array of exactly 3 short follow-up suggestions.',
        `Student context: ${JSON.stringify(context)}`
    ].join(' ');

    try {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                input: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: String(message || '') }
                ],
                max_output_tokens: 320,
                temperature: 0.5
            })
        });

        const data = await response.json();
        if (!response.ok) {
            console.error('OpenAI mentor call failed:', response.status, data?.error?.message || 'Unknown error');
            return null;
        }
        let text = String(data.output_text || '').trim();
        if (!text && Array.isArray(data.output)) {
            const textChunks = [];
            for (const item of data.output) {
                const content = Array.isArray(item?.content) ? item.content : [];
                for (const part of content) {
                    if (typeof part?.text === 'string') {
                        textChunks.push(part.text);
                    } else if (typeof part?.output_text === 'string') {
                        textChunks.push(part.output_text);
                    }
                }
            }
            text = textChunks.join('\n').trim();
        }
        if (!text) return null;

        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            // Accept plain-text output as reply.
        }
        if (!parsed || typeof parsed.reply !== 'string' || !Array.isArray(parsed.suggestions)) {
            return {
                reply: text,
                suggestions: fallback.suggestions || [],
                provider: 'chatgpt'
            };
        }

        return {
            reply: parsed.reply.trim() || fallback.reply,
            suggestions: parsed.suggestions.slice(0, 3).map(item => String(item || '').trim()).filter(Boolean),
            provider: 'chatgpt'
        };
    } catch (error) {
        console.error('OpenAI mentor call exception:', error && error.message ? error.message : error);
        return null;
    }
}

async function getGeminiMentorReply(user = {}, message = '') {
    if (!GEMINI_API_KEY) return null;
    const context = buildMentorContext(user);
    const fallback = generateMentorChatReply(user, message);

    const prompt = [
        'You are an AI Personal Mentor for a computer training institute dashboard.',
        'Speak like a practical teacher: concise, supportive, direct, and action-oriented.',
        'Always personalize using the student context below.',
        'Return strict JSON only with keys: reply, suggestions.',
        'reply: one short paragraph.',
        'suggestions: array of exactly 3 short follow-up suggestions.',
        `Student context: ${JSON.stringify(context)}`,
        `Student question: ${String(message || '')}`
    ].join('\n');

    try {
        const modelsToTry = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean)
            .filter((model, index, arr) => arr.indexOf(model) === index);

        let text = '';
        let lastError = null;

        for (const modelName of modelsToTry) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: prompt }]
                        }
                    ],
                    generationConfig: {
                        temperature: 0.5,
                        maxOutputTokens: 360
                    }
                })
            });

            const data = await response.json();
            if (!response.ok) {
                lastError = data?.error?.message || 'Unknown error';
                if (response.status === 404 || response.status === 400 || response.status === 429) {
                    continue;
                }
                console.error('Gemini mentor call failed:', response.status, lastError);
                return null;
            }

            text = String(
                data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                ''
            ).trim();
            if (text) break;
        }

        if (!text) {
            if (lastError) {
                console.error('Gemini mentor call failed:', lastError);
            }
            return null;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            // Accept plain text response.
        }

        if (!parsed || typeof parsed.reply !== 'string' || !Array.isArray(parsed.suggestions)) {
            return {
                reply: text,
                suggestions: fallback.suggestions || [],
                provider: 'gemini'
            };
        }

        return {
            reply: parsed.reply.trim() || fallback.reply,
            suggestions: parsed.suggestions.slice(0, 3).map(item => String(item || '').trim()).filter(Boolean),
            provider: 'gemini'
        };
    } catch (error) {
        console.error('Gemini mentor call exception:', error && error.message ? error.message : error);
        return null;
    }
}

function generateWebsiteAssistantFallback(question = '') {
    const q = String(question || '').toLowerCase();
    const catalog = getCoursesCatalog();
    const topCourses = catalog.slice(0, 6).map(item => item.title).join(', ');
    const totalCourses = catalog.length;

    let answer = `Tejas Computer Institute offers ${totalCourses}+ practical courses including ${topCourses}. We provide beginner-to-advanced tracks, project-based training, flexible weekday/weekend batches, and certification support. You can explore course details on the Courses page or contact us for counseling.`;
    let suggestions = [
        'Show top beginner-friendly courses',
        'Which course is best for jobs?',
        'Tell me about fees and duration'
    ];

    if (/(fee|price|cost)/i.test(q)) {
        answer = 'Course fees depend on the selected program and duration. Open the Courses page to compare options, then contact the institute for the current fee and batch offer details.';
        suggestions = [
            'Compare programming course durations',
            'Show career-focused courses',
            'How to choose the right track?'
        ];
    } else if (/(contact|phone|email|address|location)/i.test(q)) {
        answer = 'You can contact Tejas Computer Institute by phone at +91 8934039262 or email at pk5952424@gmail.com. The center is located in Kasia, Kushinagar, Uttar Pradesh.';
        suggestions = [
            'Show available batches',
            'Tell me about counseling support',
            'Which courses are most popular?'
        ];
    } else if (/(job|career|placement|interview)/i.test(q)) {
        answer = 'The institute follows a career-led approach with hands-on projects, interview preparation, and portfolio guidance. Job-ready tracks include Web Development, Python, Java, Data Science, and Cloud-related programs.';
        suggestions = [
            'Best course for software jobs',
            'Beginner to advanced roadmap',
            'How long to become job-ready?'
        ];
    }

    return {
        answer,
        suggestions
    };
}

async function getGeminiWebsiteReply(message = '') {
    if (!GEMINI_API_KEY) return null;

    const catalog = getCoursesCatalog();
    const compactCourses = catalog.slice(0, 12).map(item => ({
        title: item.title,
        duration: item.duration,
        level: item.level
    }));

    const prompt = [
        'You are a homepage AI guide for Tejas Computer Institute website.',
        'Answer only about this institute and its offerings.',
        'Tone: concise, practical, student-friendly.',
        'Do not invent unavailable facts. If unknown, say users should contact the institute.',
        'Return strict JSON only with keys: answer, suggestions.',
        'answer: one short paragraph (max 90 words).',
        'suggestions: array of exactly 3 short follow-up suggestions.',
        `Institute data: ${JSON.stringify({
            name: 'Tejas Computer Institute',
            phone: '+91 8934039262',
            email: 'pk5952424@gmail.com',
            location: 'Kasia, Kushinagar, Uttar Pradesh',
            totalCourses: catalog.length,
            courses: compactCourses
        })}`,
        `User question: ${String(message || '')}`
    ].join('\n');

    try {
        const modelsToTry = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean)
            .filter((model, index, arr) => arr.indexOf(model) === index);

        let text = '';
        let lastError = null;

        for (const modelName of modelsToTry) {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: prompt }]
                        }
                    ],
                    generationConfig: {
                        temperature: 0.4,
                        maxOutputTokens: 320
                    }
                })
            });

            const data = await response.json();
            if (!response.ok) {
                lastError = data?.error?.message || 'Unknown error';
                if (response.status === 404 || response.status === 400 || response.status === 429) {
                    continue;
                }
                console.error('Gemini website assistant call failed:', response.status, lastError);
                return null;
            }

            text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
            if (text) break;
        }

        if (!text) {
            if (lastError) {
                console.error('Gemini website assistant failed:', lastError);
            }
            return null;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            return {
                answer: text,
                suggestions: generateWebsiteAssistantFallback(message).suggestions
            };
        }

        if (!parsed || typeof parsed.answer !== 'string' || !Array.isArray(parsed.suggestions)) {
            return {
                answer: text,
                suggestions: generateWebsiteAssistantFallback(message).suggestions
            };
        }

        return {
            answer: parsed.answer.trim(),
            suggestions: parsed.suggestions.slice(0, 3).map(item => String(item || '').trim()).filter(Boolean)
        };
    } catch (error) {
        console.error('Gemini website assistant exception:', error && error.message ? error.message : error);
        return null;
    }
}

async function getChatGptWebsiteReply(message = '') {
    if (!OPENAI_API_KEY) return null;

    const catalog = getCoursesCatalog();
    const compactCourses = catalog.slice(0, 12).map(item => ({
        title: item.title,
        duration: item.duration,
        level: item.level
    }));

    const prompt = [
        'You are a homepage AI guide for Tejas Computer Institute website.',
        'Answer only about this institute and its offerings.',
        'Tone: concise, practical, student-friendly.',
        'Do not invent unavailable facts. If unknown, ask users to contact the institute.',
        'Return strict JSON only with keys: answer, suggestions.',
        'answer: one short paragraph (max 90 words).',
        'suggestions: array of exactly 3 short follow-up suggestions.',
        `Institute data: ${JSON.stringify({
            name: 'Tejas Computer Institute',
            phone: '+91 8934039262',
            email: 'pk5952424@gmail.com',
            location: 'Kasia, Kushinagar, Uttar Pradesh',
            totalCourses: catalog.length,
            courses: compactCourses
        })}`,
        `User question: ${String(message || '')}`
    ].join('\n');

    try {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                input: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: String(message || '') }
                ],
                max_output_tokens: 320,
                temperature: 0.4
            })
        });

        const data = await response.json();
        if (!response.ok) {
            console.error('OpenAI website assistant call failed:', response.status, data?.error?.message || 'Unknown error');
            return null;
        }

        let text = String(data.output_text || '').trim();
        if (!text && Array.isArray(data.output)) {
            const chunks = [];
            for (const item of data.output) {
                const content = Array.isArray(item?.content) ? item.content : [];
                for (const part of content) {
                    if (typeof part?.text === 'string') chunks.push(part.text);
                    if (typeof part?.output_text === 'string') chunks.push(part.output_text);
                }
            }
            text = chunks.join('\n').trim();
        }
        if (!text) return null;

        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            return {
                answer: text,
                suggestions: generateWebsiteAssistantFallback(message).suggestions
            };
        }

        if (!parsed || typeof parsed.answer !== 'string' || !Array.isArray(parsed.suggestions)) {
            return {
                answer: text,
                suggestions: generateWebsiteAssistantFallback(message).suggestions
            };
        }

        return {
            answer: parsed.answer.trim(),
            suggestions: parsed.suggestions.slice(0, 3).map(item => String(item || '').trim()).filter(Boolean)
        };
    } catch (error) {
        console.error('OpenAI website assistant exception:', error && error.message ? error.message : error);
        return null;
    }
}

function normalizeUserEnrollment(user = {}) {
    const normalizedCourse = typeof user.course === 'string' ? user.course.trim() : '';
    const normalizedStatus = user.accountStatus === 'blocked' ? 'blocked' : 'active';
    const sourceList = Array.isArray(user.enrolledCourses) ? user.enrolledCourses : [];
    const map = new Map();

    sourceList.forEach(entry => {
        if (!entry || !entry.title) return;
        const title = String(entry.title).trim();
        if (!title) return;
        const slug = String(entry.slug || slugifyCourse(title)).trim();
        if (!map.has(slug)) {
            map.set(slug, { title, slug });
        }
    });

    const enrolledCourses = [...map.values()];
    const gamification = normalizeGamification(user.gamification || {});
    const practiceSource = user.practiceArena && typeof user.practiceArena === 'object' ? user.practiceArena : {};
    const solvedChallengeIds = Array.isArray(practiceSource.solvedChallengeIds)
        ? [...new Set(practiceSource.solvedChallengeIds.map(id => String(id || '').trim()).filter(Boolean))]
        : [];
    const practiceArena = {
        solvedChallengeIds,
        attempts: Math.max(0, Number(practiceSource.attempts) || 0),
        lastAttemptAt: String(practiceSource.lastAttemptAt || '')
    };
    return {
        ...user,
        course: normalizedCourse,
        accountStatus: normalizedStatus,
        enrolledCourses,
        gamification,
        practiceArena
    };
}

function toClientUser(user = {}) {
    const normalized = normalizeUserEnrollment(user);
    const { password: _, ...safeUser } = normalized;
    return safeUser;
}

let usersNormalized = false;
for (let i = 0; i < users.length; i += 1) {
    const before = JSON.stringify(users[i] || {});
    const normalized = normalizeUserEnrollment(users[i] || {});
    users[i] = normalized;
    if (before !== JSON.stringify(normalized)) {
        usersNormalized = true;
    }
}
if (usersNormalized) {
    saveData(usersFile, users);
}

function normalizeInquiry(entry = {}) {
    const status = entry.status === 'resolved' ? 'resolved' : 'pending';
    return {
        ...entry,
        status
    };
}

function getTopCourseDemand() {
    const scoreMap = new Map();
    const addScore = (courseName, score) => {
        const key = (courseName || 'General').trim() || 'General';
        scoreMap.set(key, (scoreMap.get(key) || 0) + score);
    };

    inquiries.forEach(entry => addScore(entry.course, 2));
    users.forEach(entry => addScore(entry.course, 3));

    if (scoreMap.size === 0) {
        return { course: 'No data yet', score: 0 };
    }

    let top = { course: 'No data yet', score: 0 };
    for (const [course, score] of scoreMap.entries()) {
        if (score > top.score) {
            top = { course, score };
        }
    }
    return top;
}

const COURSE_SPECIAL_TRACKS = {
    'Python Programming': ['NumPy advanced arrays', 'Pandas data wrangling', 'Django authentication', 'FastAPI service creation', 'Web scraping automation', 'Python interview coding rounds'],
    'Java Programming': ['Spring Boot REST APIs', 'Java multithreading', 'Collections deep dive', 'Design patterns in Java', 'Maven and dependency management', 'Java interview preparation'],
    'C++ Programming': ['Memory model and optimization', 'Pointers and dynamic allocation', 'STL algorithms mastery', 'OOP in C++', 'File streams in C++', 'Competitive programming patterns'],
    'Data Science & AI': ['Data preprocessing pipeline', 'Feature engineering strategies', 'Supervised model selection', 'Model interpretability', 'AI use-case development', 'End-to-end ML project'],
    'Web Development': ['Advanced CSS layouts', 'JavaScript asynchronous flow', 'React hooks and context', 'Node.js API architecture', 'Authentication and authorization', 'Deployment and monitoring'],
    'Basic Computer & MS Office': ['Windows troubleshooting basics', 'MS Word formatting mastery', 'Excel formulas and dashboards', 'PowerPoint storytelling', 'Email etiquette and productivity', 'Digital file security'],
    'Tally Prime & GST': ['Tally company setup', 'GST invoice workflow', 'Input credit calculation', 'Ledger and voucher mastery', 'Return filing process', 'Final accounts reports'],
    'Digital Skills': ['Social media growth strategy', 'Canva content creation', 'SEO fundamentals', 'Digital communication etiquette', 'Personal branding online', 'Analytics for campaign tracking'],
    'C Programming': ['Pointers and arrays mastery', 'Structure and union usage', 'Dynamic memory allocation', 'File handling in C', 'Bitwise operations', 'C interview problem set'],
    'JavaScript & React': ['ES6+ deep dive', 'DOM and browser APIs', 'React routing and forms', 'State management patterns', 'Performance optimization', 'Frontend interview preparation'],
    'Machine Learning': ['Regression and classification', 'Model tuning and cross-validation', 'Pipeline construction', 'NLP and text features', 'TensorFlow fundamentals', 'ML deployment basics'],
    'Database Management (SQL)': ['Schema design principles', 'Advanced joins and CTEs', 'Query optimization', 'Transactions and ACID', 'Stored procedures', 'Database interview SQL rounds'],
    'Cloud Computing (AWS)': ['IAM security policy design', 'EC2 deployment workflow', 'S3 lifecycle policies', 'Load balancing and autoscaling', 'Cloud monitoring and logs', 'Cost optimization best practices'],
    'Mobile App Development': ['Flutter widgets and layouts', 'State management', 'Mobile API integrations', 'Authentication and local storage', 'Publishing and release pipeline', 'Mobile performance tuning'],
    'DevOps & Docker': ['Container orchestration basics', 'Dockerfile optimization', 'CI/CD pipeline setup', 'Infrastructure as code intro', 'Monitoring and alerting', 'Release management strategies'],
    'Cyber Security': ['Threat modeling', 'Network security controls', 'Vulnerability scanning', 'Secure coding practices', 'Incident response basics', 'Security compliance overview'],
    'Data Structures & Algorithms': ['Two-pointer techniques', 'Binary search patterns', 'Tree traversals and recursion', 'Dynamic programming introduction', 'Graph traversal patterns', 'Interview mock rounds'],
    'PHP & MySQL': ['Form handling and validation', 'Session and cookie management', 'MVC structuring', 'Database CRUD optimization', 'Security and sanitization', 'Project deployment'],
    'Angular Development': ['Component architecture', 'Reactive forms', 'Dependency injection patterns', 'State and RxJS basics', 'Routing and lazy loading', 'Build and deployment process'],
    'UI/UX Design': ['User research framework', 'Wireframing techniques', 'Design system components', 'Prototyping user flows', 'Accessibility principles', 'UX portfolio presentation'],
    'Software Testing': ['Test planning artifacts', 'Manual execution strategy', 'Automation framework setup', 'API testing with tools', 'Performance testing basics', 'Bug lifecycle management'],
    'Blockchain Development': ['Blockchain architecture', 'Consensus algorithms', 'Smart contract development', 'Web3 integrations', 'Token standards overview', 'DApp security essentials']
};

const SKILL_ANALYZER_TRACKS = {
    'web-development': {
        id: 'web-development',
        title: 'Web Development',
        description: 'Frontend + backend engineering readiness',
        skillMap: {
            html_css: 'HTML/CSS fundamentals',
            javascript: 'JavaScript logic',
            react_ui: 'React UI architecture',
            api_backend: 'API/backend fundamentals',
            debugging: 'Debugging and problem solving',
            deployment: 'Deployment and production flow'
        },
        roadmap: {
            beginner: ['HTML semantics, CSS layouts, and responsive design', 'JavaScript basics, DOM, events, and async', 'Build 2 mini websites and host on GitHub Pages'],
            intermediate: ['React components, state management, and routing', 'Node.js + Express APIs with auth', 'Integrate frontend with backend and SQL/NoSQL storage'],
            jobReady: ['Production-ready capstone app with CI/CD', 'Testing (unit + integration) and optimization', 'Portfolio polishing, resume bullets, and mock interviews']
        },
        questions: [
            { id: 'wd-1', skill: 'html_css', prompt: 'How confident are you with building responsive layouts using Flexbox/Grid?', options: ['Never used', 'Basic usage', 'Can build most layouts', 'Can optimize complex layouts'] },
            { id: 'wd-2', skill: 'javascript', prompt: 'How well do you understand JavaScript functions, objects, and arrays?', options: ['Very little', 'Basic understanding', 'Comfortable with daily usage', 'Advanced patterns and optimization'] },
            { id: 'wd-3', skill: 'javascript', prompt: 'Can you handle async code (Promises, async/await, API calls)?', options: ['Not yet', 'Somewhat', 'Confident', 'Advanced error/retry patterns'] },
            { id: 'wd-4', skill: 'react_ui', prompt: 'How familiar are you with React components, props, and state?', options: ['Not familiar', 'Learning basics', 'Can build full pages', 'Can design scalable architecture'] },
            { id: 'wd-5', skill: 'api_backend', prompt: 'Can you create REST APIs with backend validation/auth?', options: ['No', 'Basic CRUD only', 'Yes with auth/validation', 'Yes with robust architecture'] },
            { id: 'wd-6', skill: 'debugging', prompt: 'How do you handle debugging and fixing production bugs?', options: ['Struggle a lot', 'Need frequent help', 'Can debug independently', 'Can diagnose complex cross-layer issues'] },
            { id: 'wd-7', skill: 'deployment', prompt: 'Have you deployed full-stack apps to cloud platforms?', options: ['Never', 'Once or twice', 'Regularly', 'With monitoring and scaling'] },
            { id: 'wd-8', skill: 'deployment', prompt: 'How strong is your Git workflow (branching, PRs, conflict resolution)?', options: ['Beginner', 'Basic commits only', 'Comfortable team workflow', 'Advanced release workflow'] }
        ]
    },
    'python-programming': {
        id: 'python-programming',
        title: 'Python Programming',
        description: 'Core Python, automation, and backend readiness',
        skillMap: {
            syntax: 'Python syntax and core concepts',
            dsa: 'Problem solving and DSA',
            automation: 'Automation scripting',
            backend: 'Django/FastAPI backend',
            data: 'Data processing with pandas',
            testing: 'Testing and code quality'
        },
        roadmap: {
            beginner: ['Python basics, functions, OOP, and modules', 'Problem solving practice (30+ coding tasks)', 'Automation mini-projects (files, APIs, data cleanup)'],
            intermediate: ['Build backend APIs with FastAPI or Django', 'Database integration and authentication', 'Data analysis workflows with pandas and visualizations'],
            jobReady: ['Deploy backend project with Docker/cloud', 'Write tests and improve reliability', 'Interview prep: Python + backend system questions']
        },
        questions: [
            { id: 'py-1', skill: 'syntax', prompt: 'How comfortable are you with Python syntax, loops, and functions?', options: ['Beginner', 'Basic usage', 'Confident', 'Advanced and efficient'] },
            { id: 'py-2', skill: 'syntax', prompt: 'How well do you understand OOP in Python?', options: ['Not yet', 'Basic classes', 'Can design OOP modules', 'Can apply SOLID-style design'] },
            { id: 'py-3', skill: 'dsa', prompt: 'How often do you solve coding/logic problems?', options: ['Rarely', 'Sometimes', 'Regularly', 'Daily with strong consistency'] },
            { id: 'py-4', skill: 'automation', prompt: 'Can you automate repetitive tasks with Python scripts?', options: ['No', 'Simple scripts', 'End-to-end workflows', 'Robust production-grade automation'] },
            { id: 'py-5', skill: 'backend', prompt: 'Can you build Python APIs (FastAPI/Django) with auth?', options: ['No', 'Basic endpoints', 'Yes with auth and DB', 'Yes with architecture and performance focus'] },
            { id: 'py-6', skill: 'data', prompt: 'How comfortable are you with pandas for data transformation?', options: ['Never used', 'Basic operations', 'Confident analysis', 'Advanced data pipelines'] },
            { id: 'py-7', skill: 'testing', prompt: 'Do you write tests (unit/integration) for your Python code?', options: ['Never', 'Sometimes', 'Usually', 'Consistently with quality checks'] },
            { id: 'py-8', skill: 'backend', prompt: 'Have you deployed Python projects?', options: ['Not yet', 'Once', 'Multiple times', 'With CI/CD and monitoring'] }
        ]
    },
    'data-science-ai': {
        id: 'data-science-ai',
        title: 'Data Science & AI',
        description: 'Data analysis, ML modeling, and deployment readiness',
        skillMap: {
            python_data: 'Python for data',
            statistics: 'Statistics and experimentation',
            ml: 'ML model development',
            feature_eng: 'Feature engineering',
            evaluation: 'Model evaluation',
            deployment: 'Model deployment'
        },
        roadmap: {
            beginner: ['Python, numpy, pandas, and EDA basics', 'Statistics foundations and hypothesis testing', 'Build first regression/classification mini models'],
            intermediate: ['Feature engineering and model tuning', 'Cross-validation and evaluation metrics', 'End-to-end notebooks for real datasets'],
            jobReady: ['Production ML pipeline and API serving', 'Model monitoring and drift awareness', 'Case-study portfolio + interview storytelling']
        },
        questions: [
            { id: 'ds-1', skill: 'python_data', prompt: 'How confident are you with pandas/numpy for data cleaning?', options: ['Not confident', 'Basic usage', 'Confident', 'Advanced pipelines'] },
            { id: 'ds-2', skill: 'statistics', prompt: 'How well do you understand probability and basic statistics?', options: ['Beginner', 'Basic', 'Good understanding', 'Strong applied understanding'] },
            { id: 'ds-3', skill: 'ml', prompt: 'Can you train and compare ML models for a business problem?', options: ['Not yet', 'With help', 'Independently', 'With optimization and strong rationale'] },
            { id: 'ds-4', skill: 'feature_eng', prompt: 'How much feature engineering experience do you have?', options: ['None', 'Basic transformations', 'Useful engineered features', 'Advanced feature strategies'] },
            { id: 'ds-5', skill: 'evaluation', prompt: 'How comfortable are you with metrics like F1, ROC-AUC, MAE, RMSE?', options: ['Low', 'Basic', 'Confident', 'Advanced metric selection'] },
            { id: 'ds-6', skill: 'deployment', prompt: 'Have you deployed ML models to an API/app?', options: ['Never', 'Once', 'Multiple times', 'Production-grade deployments'] },
            { id: 'ds-7', skill: 'statistics', prompt: 'Can you explain model decisions to non-technical stakeholders?', options: ['Hard for me', 'Somewhat', 'Usually', 'Very confident communicator'] },
            { id: 'ds-8', skill: 'ml', prompt: 'How consistently do you run experiments and track outcomes?', options: ['Rarely', 'Sometimes', 'Regularly', 'Disciplined experiment workflow'] }
        ]
    },
    'java-programming': {
        id: 'java-programming',
        title: 'Java Programming',
        description: 'Core Java, OOP, and backend readiness',
        skillMap: {
            core_java: 'Core Java fundamentals',
            oops: 'OOP and design principles',
            collections: 'Collections and data handling',
            spring: 'Spring/Spring Boot',
            sql: 'Database integration',
            testing: 'Testing and debugging'
        },
        roadmap: {
            beginner: ['Core Java syntax, control flow, and methods', 'OOP principles with practical exercises', 'Collections and exception handling practice'],
            intermediate: ['Spring Boot REST APIs and layered architecture', 'JPA/Hibernate with SQL databases', 'Authentication and validation in APIs'],
            jobReady: ['Build production-style Java backend project', 'Testing strategy (JUnit + integration)', 'Interview prep: Java, Spring, and system design basics']
        },
        questions: [
            { id: 'jv-1', skill: 'core_java', prompt: 'How confident are you with core Java syntax and classes?', options: ['Low', 'Basic', 'Confident', 'Advanced'] },
            { id: 'jv-2', skill: 'oops', prompt: 'How well do you apply OOP principles in Java projects?', options: ['Not yet', 'Basic', 'Good', 'Strong architecture focus'] },
            { id: 'jv-3', skill: 'collections', prompt: 'How comfortable are you with Java Collections and streams?', options: ['Low', 'Basic', 'Confident', 'Advanced performance-aware usage'] },
            { id: 'jv-4', skill: 'spring', prompt: 'Can you build REST APIs with Spring Boot?', options: ['No', 'Basic CRUD', 'Yes with auth/validation', 'Yes with production patterns'] },
            { id: 'jv-5', skill: 'sql', prompt: 'Can you integrate Java apps with SQL databases using JPA/Hibernate?', options: ['No', 'Basic integration', 'Confident', 'Advanced modeling and optimization'] },
            { id: 'jv-6', skill: 'testing', prompt: 'How often do you write tests and debug efficiently?', options: ['Rarely', 'Sometimes', 'Regularly', 'Consistent quality workflow'] },
            { id: 'jv-7', skill: 'spring', prompt: 'Do you understand dependency injection and layered architecture?', options: ['Not yet', 'Basic', 'Confident', 'Can mentor others'] },
            { id: 'jv-8', skill: 'core_java', prompt: 'How prepared are you for Java technical interviews?', options: ['Not prepared', 'Some basics', 'Mostly prepared', 'Strong readiness'] }
        ]
    }
};

const CAREER_PATH_BLUEPRINTS = {
    'data-analyst': {
        id: 'data-analyst',
        title: 'Data Analyst',
        summary: 'Build strong analytics, SQL, visualization, and business insight skills.',
        recommendedCourses: ['Python Programming', 'Database Management (SQL)', 'Data Science & AI', 'Machine Learning'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: [
                    'Python basics for data handling',
                    'SQL fundamentals and query writing',
                    'Excel and basic data visualization workflow'
                ]
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: [
                    'Advanced pandas and exploratory data analysis',
                    'Dashboard creation and storytelling',
                    'Statistics for analysis and decision making'
                ]
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: [
                    'End-to-end analytics capstone project',
                    'Portfolio with 3 business case studies',
                    'Interview prep: SQL, analytics scenarios, KPI thinking'
                ]
            }
        ]
    },
    'software-developer': {
        id: 'software-developer',
        title: 'Software Developer',
        summary: 'Master programming, full-stack development, and production engineering.',
        recommendedCourses: ['Web Development', 'JavaScript & React', 'Java Programming', 'DevOps & Docker'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: [
                    'Programming fundamentals and problem solving',
                    'Git/GitHub workflow and clean code habits',
                    'HTML/CSS/JavaScript basics'
                ]
            },
            {
                stage: 'Intermediate',
                duration: '8-10 Weeks',
                milestones: [
                    'Frontend app architecture with React',
                    'Backend APIs, authentication, and databases',
                    'Testing and debugging workflow'
                ]
            },
            {
                stage: 'Job Ready',
                duration: '8-12 Weeks',
                milestones: [
                    'Production-grade full-stack project',
                    'Deployment, CI/CD, and monitoring basics',
                    'Interview prep: DSA + system design basics'
                ]
            }
        ]
    },
    'ai-engineer': {
        id: 'ai-engineer',
        title: 'AI Engineer',
        summary: 'Develop ML/AI systems from model training to deployment and monitoring.',
        recommendedCourses: ['Python Programming', 'Data Science & AI', 'Machine Learning', 'Cloud Computing (AWS)'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '6-8 Weeks',
                milestones: [
                    'Python for data and scientific computing',
                    'Math/statistics for machine learning',
                    'Data preprocessing and feature basics'
                ]
            },
            {
                stage: 'Intermediate',
                duration: '8-10 Weeks',
                milestones: [
                    'Train and evaluate ML models',
                    'Model tuning and experiment tracking',
                    'NLP/CV fundamentals based on interest area'
                ]
            },
            {
                stage: 'Job Ready',
                duration: '8-12 Weeks',
                milestones: [
                    'Model serving with APIs',
                    'MLOps basics: monitoring, drift, retraining',
                    'AI portfolio with real-world deployment project'
                ]
            }
        ]
    },
    'backend-developer': {
        id: 'backend-developer',
        title: 'Backend Developer',
        summary: 'Build robust APIs, databases, and scalable backend systems.',
        recommendedCourses: ['Java Programming', 'Python Programming', 'Database Management (SQL)', 'DevOps & Docker'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: ['Programming and OOP fundamentals', 'SQL and relational data modeling', 'HTTP, REST, and API design basics']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['Authentication and authorization flows', 'Caching, queues, and performance basics', 'Testing and debugging backend services']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Scalable backend capstone project', 'Deployment with monitoring and logs', 'Interview prep for backend scenarios']
            }
        ]
    },
    'frontend-developer': {
        id: 'frontend-developer',
        title: 'Frontend Developer',
        summary: 'Create responsive, accessible, and high-performance user interfaces.',
        recommendedCourses: ['Web Development', 'JavaScript & React', 'UI/UX Design', 'Angular Development'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-5 Weeks',
                milestones: ['HTML/CSS/JS fundamentals', 'Responsive design and accessibility basics', 'Component thinking and UI patterns']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['React/Angular app architecture', 'API integrations and state handling', 'UI performance optimization techniques']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Portfolio-grade frontend projects', 'Testing UI behavior and edge cases', 'Interview prep for frontend roles']
            }
        ]
    },
    'full-stack-developer': {
        id: 'full-stack-developer',
        title: 'Full Stack Developer',
        summary: 'Build complete web applications across frontend, backend, and deployment.',
        recommendedCourses: ['Web Development', 'JavaScript & React', 'Database Management (SQL)', 'DevOps & Docker'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '5-6 Weeks',
                milestones: ['Frontend + backend core basics', 'SQL and data modeling fundamentals', 'Git and collaboration workflow']
            },
            {
                stage: 'Intermediate',
                duration: '8-10 Weeks',
                milestones: ['Build integrated full-stack apps', 'Authentication and role-based access', 'Error handling and production best practices']
            },
            {
                stage: 'Job Ready',
                duration: '8-12 Weeks',
                milestones: ['Deploy full-stack capstone with CI/CD', 'Performance tuning and observability', 'Interview prep for product engineering roles']
            }
        ]
    },
    'cloud-engineer': {
        id: 'cloud-engineer',
        title: 'Cloud Engineer',
        summary: 'Design and operate cloud infrastructure and services.',
        recommendedCourses: ['Cloud Computing (AWS)', 'DevOps & Docker', 'Cyber Security', 'Database Management (SQL)'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: ['Cloud fundamentals and core services', 'Linux and networking basics', 'Identity and access management essentials']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['Compute, storage, and networking architecture', 'Infrastructure as code basics', 'Monitoring, logging, and alerts']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Production cloud deployment project', 'Cost optimization and reliability design', 'Interview prep for cloud scenarios']
            }
        ]
    },
    'devops-engineer': {
        id: 'devops-engineer',
        title: 'DevOps Engineer',
        summary: 'Automate build, deployment, and infrastructure operations.',
        recommendedCourses: ['DevOps & Docker', 'Cloud Computing (AWS)', 'Software Testing', 'Cyber Security'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: ['Linux, shell, and networking essentials', 'Version control and build pipeline basics', 'Container fundamentals with Docker']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['CI/CD pipeline design and automation', 'Container orchestration concepts', 'Monitoring and incident response basics']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['End-to-end DevOps capstone implementation', 'Infrastructure as code and release strategy', 'Interview prep for DevOps tooling']
            }
        ]
    },
    'cybersecurity-analyst': {
        id: 'cybersecurity-analyst',
        title: 'Cybersecurity Analyst',
        summary: 'Protect systems through threat detection, hardening, and response.',
        recommendedCourses: ['Cyber Security', 'Cloud Computing (AWS)', 'Software Testing', 'Database Management (SQL)'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: ['Security fundamentals and threat landscape', 'Network and endpoint basics', 'Identity and access controls']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['Vulnerability assessment and remediation', 'Secure coding and testing practices', 'Logging and SIEM basics']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Incident response simulation project', 'Security audit and reporting workflow', 'Interview prep for analyst and SOC roles']
            }
        ]
    },
    'mobile-app-developer': {
        id: 'mobile-app-developer',
        title: 'Mobile App Developer',
        summary: 'Design and build performant Android/iOS applications.',
        recommendedCourses: ['Mobile App Development', 'Java Programming', 'UI/UX Design', 'Cloud Computing (AWS)'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-6 Weeks',
                milestones: ['Mobile UI fundamentals and navigation', 'State management basics', 'API integration and local storage']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['Architecture for scalable mobile apps', 'Authentication, push notifications, and caching', 'Mobile testing and debugging workflow']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Production-ready mobile capstone app', 'App publishing and release pipeline', 'Interview prep for mobile development roles']
            }
        ]
    },
    'qa-automation-engineer': {
        id: 'qa-automation-engineer',
        title: 'QA Automation Engineer',
        summary: 'Ensure software quality using automated testing and quality strategy.',
        recommendedCourses: ['Software Testing', 'Python Programming', 'Web Development', 'DevOps & Docker'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-5 Weeks',
                milestones: ['Testing fundamentals and bug lifecycle', 'Manual testing strategy', 'Test case design and execution']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['Automation frameworks and scripting', 'API testing and integration checks', 'Performance and reliability testing basics']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Automation suite capstone project', 'CI integration for automated tests', 'Interview prep for QA and SDET roles']
            }
        ]
    },
    'ui-ux-designer': {
        id: 'ui-ux-designer',
        title: 'UI/UX Designer',
        summary: 'Create user-centered digital experiences with strong design systems.',
        recommendedCourses: ['UI/UX Design', 'Web Development', 'Digital Skills', 'Mobile App Development'],
        roadmap: [
            {
                stage: 'Foundation',
                duration: '4-5 Weeks',
                milestones: ['Design principles and user psychology basics', 'Wireframing and layout fundamentals', 'Design tool proficiency']
            },
            {
                stage: 'Intermediate',
                duration: '6-8 Weeks',
                milestones: ['User research and journey mapping', 'Design systems and prototyping', 'Usability testing and iteration']
            },
            {
                stage: 'Job Ready',
                duration: '6-10 Weeks',
                milestones: ['Portfolio-ready case studies', 'Cross-functional collaboration workflow', 'Interview prep for UI/UX roles']
            }
        ]
    }
};

const PRACTICE_CHALLENGES = [
    {
        id: 'two-sum',
        title: 'Two Sum',
        difficulty: 'Easy',
        category: 'Arrays',
        interview: true,
        tags: ['array', 'hashmap'],
        functionName: 'solve',
        statement: 'Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.',
        constraints: ['2 <= nums.length <= 1e5', '-1e9 <= nums[i], target <= 1e9', 'Exactly one valid answer exists'],
        examples: [{ input: 'nums = [2,7,11,15], target = 9', output: '[0,1]' }],
        tests: [
            { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
            { args: [[3, 2, 4], 6], expected: [1, 2] },
            { args: [[3, 3], 6], expected: [0, 1] }
        ],
        starterCode: {
            javascript: `function solve(nums, target) {\n  // return [i, j]\n  return [];\n}`,
            python: `def solve(nums, target):\n    # return [i, j]\n    return []`
        }
    },
    {
        id: 'valid-parentheses',
        title: 'Valid Parentheses',
        difficulty: 'Easy',
        category: 'Stack',
        interview: true,
        tags: ['stack', 'string'],
        functionName: 'solve',
        statement: 'Given a string s containing just characters ()[]{} determine if the input string is valid.',
        constraints: ['1 <= s.length <= 1e4'],
        examples: [{ input: 's = "()[]{}"', output: 'true' }],
        tests: [
            { args: ['()[]{}'], expected: true },
            { args: ['(]'], expected: false },
            { args: ['([{}])'], expected: true }
        ],
        starterCode: {
            javascript: `function solve(s) {\n  return false;\n}`,
            python: `def solve(s):\n    return False`
        }
    },
    {
        id: 'binary-search',
        title: 'Binary Search',
        difficulty: 'Easy',
        category: 'Searching',
        interview: true,
        tags: ['binary-search', 'array'],
        functionName: 'solve',
        statement: 'Given a sorted array nums and a target value, return its index if found, otherwise -1.',
        constraints: ['nums is sorted in ascending order'],
        examples: [{ input: 'nums=[-1,0,3,5,9,12], target=9', output: '4' }],
        tests: [
            { args: [[-1, 0, 3, 5, 9, 12], 9], expected: 4 },
            { args: [[-1, 0, 3, 5, 9, 12], 2], expected: -1 },
            { args: [[1], 1], expected: 0 }
        ],
        starterCode: {
            javascript: `function solve(nums, target) {\n  return -1;\n}`,
            python: `def solve(nums, target):\n    return -1`
        }
    },
    {
        id: 'group-anagrams',
        title: 'Group Anagrams',
        difficulty: 'Medium',
        category: 'Hashing',
        interview: true,
        tags: ['hashmap', 'string', 'sorting'],
        functionName: 'solve',
        statement: 'Given an array of strings strs, group the anagrams together and return the grouped list.',
        constraints: ['1 <= strs.length <= 1e4'],
        examples: [{ input: '["eat","tea","tan","ate","nat","bat"]', output: '[["eat","tea","ate"],["tan","nat"],["bat"]]' }],
        tests: [
            { args: [['eat', 'tea', 'tan', 'ate', 'nat', 'bat']], expected: [['ate', 'eat', 'tea'], ['nat', 'tan'], ['bat']] },
            { args: [['']], expected: [['']] }
        ],
        normalize: 'sort-nested',
        starterCode: {
            javascript: `function solve(strs) {\n  return [];\n}`,
            python: `def solve(strs):\n    return []`
        }
    },
    {
        id: 'longest-substring-no-repeat',
        title: 'Longest Substring Without Repeating Characters',
        difficulty: 'Medium',
        category: 'Sliding Window',
        interview: true,
        tags: ['sliding-window', 'string'],
        functionName: 'solve',
        statement: 'Given a string s, find the length of the longest substring without repeating characters.',
        constraints: ['0 <= s.length <= 5e4'],
        examples: [{ input: '"abcabcbb"', output: '3' }],
        tests: [
            { args: ['abcabcbb'], expected: 3 },
            { args: ['bbbbb'], expected: 1 },
            { args: ['pwwkew'], expected: 3 }
        ],
        starterCode: {
            javascript: `function solve(s) {\n  return 0;\n}`,
            python: `def solve(s):\n    return 0`
        }
    },
    {
        id: 'top-k-frequent-elements',
        title: 'Top K Frequent Elements',
        difficulty: 'Medium',
        category: 'Heaps',
        interview: true,
        tags: ['heap', 'hashmap'],
        functionName: 'solve',
        statement: 'Given an integer array nums and integer k, return the k most frequent elements.',
        constraints: ['1 <= nums.length <= 1e5'],
        examples: [{ input: 'nums=[1,1,1,2,2,3], k=2', output: '[1,2]' }],
        tests: [
            { args: [[1, 1, 1, 2, 2, 3], 2], expected: [1, 2] },
            { args: [[1], 1], expected: [1] }
        ],
        normalize: 'sort',
        starterCode: {
            javascript: `function solve(nums, k) {\n  return [];\n}`,
            python: `def solve(nums, k):\n    return []`
        }
    },
    {
        id: 'merge-intervals',
        title: 'Merge Intervals',
        difficulty: 'Medium',
        category: 'Intervals',
        interview: true,
        tags: ['sorting', 'intervals'],
        functionName: 'solve',
        statement: 'Given an array of intervals, merge all overlapping intervals.',
        constraints: ['1 <= intervals.length <= 1e4'],
        examples: [{ input: '[[1,3],[2,6],[8,10],[15,18]]', output: '[[1,6],[8,10],[15,18]]' }],
        tests: [
            { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expected: [[1, 6], [8, 10], [15, 18]] },
            { args: [[[1, 4], [4, 5]]], expected: [[1, 5]] }
        ],
        starterCode: {
            javascript: `function solve(intervals) {\n  return [];\n}`,
            python: `def solve(intervals):\n    return []`
        }
    },
    {
        id: 'word-break',
        title: 'Word Break',
        difficulty: 'Medium',
        category: 'Dynamic Programming',
        interview: true,
        tags: ['dp', 'string'],
        functionName: 'solve',
        statement: 'Given a string s and a dictionary of strings wordDict, return true if s can be segmented into a space-separated sequence of one or more dictionary words.',
        constraints: ['1 <= s.length <= 300'],
        examples: [{ input: 's="leetcode", dict=["leet","code"]', output: 'true' }],
        tests: [
            { args: ['leetcode', ['leet', 'code']], expected: true },
            { args: ['applepenapple', ['apple', 'pen']], expected: true },
            { args: ['catsandog', ['cats', 'dog', 'sand', 'and', 'cat']], expected: false }
        ],
        starterCode: {
            javascript: `function solve(s, wordDict) {\n  return false;\n}`,
            python: `def solve(s, wordDict):\n    return False`
        }
    },
    {
        id: 'lru-cache-design',
        title: 'LRU Cache Design (Concept)',
        difficulty: 'Hard',
        category: 'System Design',
        interview: true,
        tags: ['design', 'hashmap', 'linked-list'],
        functionName: 'solve',
        statement: 'Implement an LRU cache. For this simplified challenge, return the final state keys after processing operations.',
        constraints: ['Use O(1) get and put operations in a full design setting'],
        examples: [{ input: 'ops=[["put",1,1],["put",2,2],["get",1],["put",3,3]], capacity=2', output: '[1,3]' }],
        tests: [
            { args: [[['put', 1, 1], ['put', 2, 2], ['get', 1], ['put', 3, 3]], 2], expected: [1, 3] }
        ],
        normalize: 'sort',
        starterCode: {
            javascript: `function solve(ops, capacity) {\n  // return final keys currently in cache\n  return [];\n}`,
            python: `def solve(ops, capacity):\n    # return final keys currently in cache\n    return []`
        }
    },
    {
        id: 'median-two-sorted-arrays',
        title: 'Median of Two Sorted Arrays',
        difficulty: 'Hard',
        category: 'Binary Search',
        interview: true,
        tags: ['binary-search', 'array'],
        functionName: 'solve',
        statement: 'Given two sorted arrays nums1 and nums2, return the median of the two sorted arrays.',
        constraints: ['The overall run time complexity should be O(log (m+n))'],
        examples: [{ input: 'nums1=[1,3], nums2=[2]', output: '2.0' }],
        tests: [
            { args: [[1, 3], [2]], expected: 2.0 },
            { args: [[1, 2], [3, 4]], expected: 2.5 }
        ],
        starterCode: {
            javascript: `function solve(nums1, nums2) {\n  return 0;\n}`,
            python: `def solve(nums1, nums2):\n    return 0`
        }
    }
];

function getSkillAnalyzerTrack(trackId = '') {
    const key = String(trackId || '').trim().toLowerCase();
    return SKILL_ANALYZER_TRACKS[key] || null;
}

function getSkillAnalyzerPublicTracks() {
    return Object.values(SKILL_ANALYZER_TRACKS).map(track => ({
        id: track.id,
        title: track.title,
        description: track.description
    }));
}

function getLevelFromScorePercent(scorePercent) {
    const score = Math.max(0, Math.min(100, Number(scorePercent) || 0));
    if (score < 40) return 'Beginner';
    if (score < 75) return 'Intermediate';
    return 'Job Ready';
}

function buildRoadmapByLevel(track, level) {
    const order = ['Beginner', 'Intermediate', 'Job Ready'];
    const index = Math.max(0, order.indexOf(level));
    const stageKey = {
        Beginner: 'beginner',
        Intermediate: 'intermediate',
        'Job Ready': 'jobReady'
    };
    return order.map((stage, idx) => ({
        stage,
        status: idx < index ? 'completed' : (idx === index ? 'current' : 'upcoming'),
        duration: stage === 'Beginner' ? '3-4 Weeks' : stage === 'Intermediate' ? '4-6 Weeks' : '4-8 Weeks',
        topics: track.roadmap[stageKey[stage]] || []
    }));
}

function getCareerPathByGoal(goal = '') {
    const key = String(goal || '').trim().toLowerCase();
    return CAREER_PATH_BLUEPRINTS[key] || null;
}

function getCareerPathGoals() {
    return Object.values(CAREER_PATH_BLUEPRINTS).map(item => ({
        id: item.id,
        title: item.title,
        summary: item.summary
    }));
}

function normalizePracticeValue(value, mode = '') {
    if (mode === 'sort' && Array.isArray(value)) {
        return [...value].sort();
    }
    if (mode === 'sort-nested' && Array.isArray(value)) {
        return value
            .map(item => (Array.isArray(item) ? [...item].sort() : item))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return value;
}

function getPracticeChallengeById(id = '') {
    return PRACTICE_CHALLENGES.find(item => item.id === String(id || '').trim());
}

function getPracticeChallengeSummary() {
    return PRACTICE_CHALLENGES.map(item => ({
        id: item.id,
        title: item.title,
        difficulty: item.difficulty,
        category: item.category,
        interview: Boolean(item.interview),
        tags: item.tags || []
    }));
}

async function evaluatePracticeChallenge(language, code, challenge) {
    const marker = '__PRACTICE_RESULT__:';
    const tests = Array.isArray(challenge.tests) ? challenge.tests : [];
    const normalizedTests = tests.map(test => ({
        args: Array.isArray(test.args) ? test.args : [],
        expected: test.expected
    }));
    const mode = challenge.normalize || '';

    if (language === 'javascript') {
        const harness = `
${code}
function __deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function __normalize(value, mode) {
  if (mode === 'sort' && Array.isArray(value)) return [...value].sort();
  if (mode === 'sort-nested' && Array.isArray(value)) return value.map(v => Array.isArray(v) ? [...v].sort() : v).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  return value;
}
(function() {
  const fn = (typeof ${challenge.functionName} === 'function')
    ? ${challenge.functionName}
    : (typeof solve === 'function' ? solve : (typeof solution === 'function' ? solution : null));
  if (!fn) {
    console.log('${marker}' + JSON.stringify({ passed: false, error: 'Function not found. Define solve(...) function.' }));
    return;
  }
  const tests = ${JSON.stringify(normalizedTests)};
  const mode = ${JSON.stringify(mode)};
  let passedCount = 0;
  for (let i = 0; i < tests.length; i += 1) {
    const t = tests[i];
    let actual;
    try {
      actual = fn(...(t.args || []));
    } catch (e) {
      console.log('${marker}' + JSON.stringify({ passed: false, passedCount, total: tests.length, failedAt: i + 1, error: String(e && e.message ? e.message : e) }));
      return;
    }
    const expected = __normalize(t.expected, mode);
    const normalizedActual = __normalize(actual, mode);
    if (!__deepEqual(normalizedActual, expected)) {
      console.log('${marker}' + JSON.stringify({ passed: false, passedCount, total: tests.length, failedAt: i + 1, expected, actual: normalizedActual }));
      return;
    }
    passedCount += 1;
  }
  console.log('${marker}' + JSON.stringify({ passed: true, passedCount, total: tests.length }));
})();`;

        const result = runJavaScriptInSandbox(harness, '');
        const outLines = String(result.stdout || '').split(/\r?\n/);
        const line = [...outLines].reverse().find(item => item.startsWith(marker));
        if (!line) {
            return { passed: false, passedCount: 0, total: tests.length, error: result.stderr || 'Invalid evaluator output.' };
        }
        try {
            return JSON.parse(line.slice(marker.length));
        } catch (error) {
            return { passed: false, passedCount: 0, total: tests.length, error: 'Could not parse evaluator result.' };
        }
    }

    if (language === 'python') {
        const pythonHarness = `
${code}
import json
def __normalize(value, mode):
    if mode == "sort" and isinstance(value, list):
        return sorted(value)
    if mode == "sort-nested" and isinstance(value, list):
        normalized = []
        for item in value:
            if isinstance(item, list):
                normalized.append(sorted(item))
            else:
                normalized.append(item)
        return sorted(normalized, key=lambda x: json.dumps(x, sort_keys=True))
    return value

def __deep_equal(a, b):
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)

def __runner():
    fn = globals().get("${challenge.functionName}") or globals().get("solve") or globals().get("solution")
    if not callable(fn):
        print("${marker}" + json.dumps({"passed": False, "error": "Function not found. Define solve(...) function."}))
        return
    tests = ${JSON.stringify(normalizedTests)}
    mode = ${JSON.stringify(mode)}
    passed_count = 0
    total = len(tests)
    for idx, t in enumerate(tests):
        args = t.get("args", [])
        expected = __normalize(t.get("expected"), mode)
        try:
            actual = fn(*args)
        except Exception as err:
            print("${marker}" + json.dumps({"passed": False, "passedCount": passed_count, "total": total, "failedAt": idx + 1, "error": str(err)}))
            return
        actual = __normalize(actual, mode)
        if not __deep_equal(actual, expected):
            print("${marker}" + json.dumps({"passed": False, "passedCount": passed_count, "total": total, "failedAt": idx + 1, "expected": expected, "actual": actual}))
            return
        passed_count += 1
    print("${marker}" + json.dumps({"passed": True, "passedCount": passed_count, "total": total}))

__runner()
`;
        const result = await runPythonInSandbox(pythonHarness, '');
        const outLines = String(result.stdout || '').split(/\r?\n/);
        const line = [...outLines].reverse().find(item => item.startsWith(marker));
        if (!line) {
            return { passed: false, passedCount: 0, total: tests.length, error: result.stderr || 'Invalid evaluator output.' };
        }
        try {
            return JSON.parse(line.slice(marker.length));
        } catch (error) {
            return { passed: false, passedCount: 0, total: tests.length, error: 'Could not parse evaluator result.' };
        }
    }

    return {
        passed: false,
        passedCount: 0,
        total: tests.length,
        error: 'Unsupported language for Practice Arena. Use JavaScript or Python.'
    };
}

function slugifyCourse(title = '') {
    return title
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function buildCourseTopics(title) {
    const baseTopics = [
        `${title}: orientation and roadmap`,
        `${title}: setup and environment preparation`,
        `${title}: terminology and core concepts`,
        `${title}: beginner hands-on exercise 1`,
        `${title}: beginner hands-on exercise 2`,
        `${title}: fundamentals recap`,
        `${title}: practical workflow design`,
        `${title}: productivity tools and shortcuts`,
        `${title}: common mistakes and debugging basics`,
        `${title}: mini assignment 1`,
        `${title}: mini assignment 2`,
        `${title}: mentor review checkpoint`,
        `${title}: intermediate concept block 1`,
        `${title}: intermediate concept block 2`,
        `${title}: intermediate concept block 3`,
        `${title}: applied lab session 1`,
        `${title}: applied lab session 2`,
        `${title}: applied lab session 3`,
        `${title}: reusable patterns and best practices`,
        `${title}: code quality and documentation`,
        `${title}: testing and validation basics`,
        `${title}: data handling practices`,
        `${title}: API and integration fundamentals`,
        `${title}: security basics`,
        `${title}: optimization techniques`,
        `${title}: architecture fundamentals`,
        `${title}: teamwork and collaboration workflow`,
        `${title}: version control and release workflow`,
        `${title}: project planning basics`,
        `${title}: project milestone 1`,
        `${title}: project milestone 2`,
        `${title}: project milestone 3`,
        `${title}: capstone project planning`,
        `${title}: capstone project implementation step 1`,
        `${title}: capstone project implementation step 2`,
        `${title}: capstone project implementation step 3`,
        `${title}: capstone testing and refinement`,
        `${title}: portfolio artifact creation`,
        `${title}: real-world case study 1`,
        `${title}: real-world case study 2`,
        `${title}: industry standards and conventions`,
        `${title}: advanced module 1`,
        `${title}: advanced module 2`,
        `${title}: advanced module 3`,
        `${title}: performance and scalability discussion`,
        `${title}: interview-focused problem set 1`,
        `${title}: interview-focused problem set 2`,
        `${title}: mock assessment 1`,
        `${title}: mock assessment 2`,
        `${title}: placement readiness session`,
        `${title}: communication and presentation skills`,
        `${title}: resume and portfolio alignment`,
        `${title}: final revision sprint`,
        `${title}: final project defense`,
        `${title}: course closure and growth plan`
    ];

    const special = COURSE_SPECIAL_TRACKS[title] || [];
    const combined = [...baseTopics, ...special];
    const unique = [...new Set(combined)];
    let idx = 1;
    while (unique.length < 56) {
        unique.push(`${title}: guided practice extension ${idx}`);
        idx += 1;
    }
    return unique.slice(0, 60);
}

function buildTopicModules(topics) {
    const moduleNames = ['Foundation', 'Core Concepts', 'Hands-on Labs', 'Advanced Layer', 'Project Build', 'Career Prep'];
    const size = Math.ceil(topics.length / moduleNames.length);
    return moduleNames.map((name, index) => ({
        name,
        topics: topics.slice(index * size, (index + 1) * size)
    })).filter(module => module.topics.length > 0);
}

function formatInrPrice(amount) {
    const value = Math.max(0, Math.round(Number(amount) || 0));
    try {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 0
        }).format(value);
    } catch (error) {
        return `INR ${value}`;
    }
}

function deriveCoursePrice(course = {}) {
    if (Number.isFinite(Number(course.price)) && Number(course.price) > 0) {
        return Math.round(Number(course.price));
    }
    const durationText = String(course.duration || '');
    const monthMatch = durationText.match(/(\d+)/);
    const months = monthMatch ? Math.max(1, Number(monthMatch[1])) : 3;
    const baseByMonths = months * 2200;
    const levelText = String(course.level || '').toLowerCase();
    const levelBonus = levelText.includes('advanced')
        ? 2200
        : levelText.includes('intermediate')
            ? 1100
            : 0;
    return baseByMonths + levelBonus;
}

function enrichCourse(course) {
    const slug = slugifyCourse(course.title);
    const topics = buildCourseTopics(course.title);
    const overridePrice = Number(coursePricingOverrides[slug]);
    const price = Number.isFinite(overridePrice) && overridePrice > 0
        ? Math.round(overridePrice)
        : deriveCoursePrice(course);
    return {
        ...course,
        price,
        priceLabel: formatInrPrice(price),
        slug,
        overview: `${course.description} This course follows a practical approach with guided assignments and mentor support.`,
        topics,
        topicModules: buildTopicModules(topics),
        outcomes: [
            `Build real-world proficiency in ${course.title}`,
            'Create guided projects for your portfolio',
            'Prepare confidently for interviews and practical assessments'
        ]
    };
}

function getCourseByIdentifier(identifier) {
    const catalog = getCoursesCatalog();
    return catalog.find(c => String(c.id) === identifier || c.slug === identifier);
}

function escapePdfText(text = '') {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

function createSimplePdf(lines) {
    const pageLineCount = 42;
    const lineHeight = 14;
    const pages = [];

    for (let i = 0; i < lines.length; i += pageLineCount) {
        pages.push(lines.slice(i, i + pageLineCount));
    }
    if (pages.length === 0) pages.push(['Syllabus']);

    const objects = [];
    const pageObjectIds = [];

    const addObject = (content) => {
        const id = objects.length + 1;
        objects.push({ id, content });
        return id;
    };

    const fontObjId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pagesObjId = addObject('<< /Type /Pages /Kids [] /Count 0 >>');

    pages.forEach((pageLines) => {
        const streamLines = ['BT', '/F1 11 Tf', '50 820 Td'];
        pageLines.forEach((line, idx) => {
            if (idx === 0) {
                streamLines.push(`(${escapePdfText(line)}) Tj`);
            } else {
                streamLines.push(`0 -${lineHeight} Td (${escapePdfText(line)}) Tj`);
            }
        });
        streamLines.push('ET');
        const streamContent = streamLines.join('\n');
        const contentObjId = addObject(`<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream`);
        const pageObjId = addObject(`<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`);
        pageObjectIds.push(pageObjId);
    });

    const catalogObjId = addObject(`<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`);
    objects[pagesObjId - 1].content = `<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj) => {
        offsets.push(Buffer.byteLength(pdf, 'utf8'));
        pdf += `${obj.id} 0 obj\n${obj.content}\nendobj\n`;
    });

    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i += 1) {
        const off = String(offsets[i]).padStart(10, '0');
        pdf += `${off} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'utf8');
}

function clipOutput(text, limit = 8000) {
    const raw = String(text || '');
    if (raw.length <= limit) return raw;
    return `${raw.slice(0, limit)}\n...output truncated...`;
}

function stringifyConsoleArg(value) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch (error) {
        return String(value);
    }
}

function runJavaScriptInSandbox(code, stdinText = '') {
    const logs = [];
    const errors = [];
    const start = Date.now();
    const inputLines = String(stdinText || '').split(/\r?\n/);
    let inputIndex = 0;
    const readInput = () => {
        if (inputIndex >= inputLines.length) return '';
        const line = inputLines[inputIndex];
        inputIndex += 1;
        return line;
    };

    const sandbox = {
        console: {
            log: (...args) => logs.push(args.map(stringifyConsoleArg).join(' ')),
            error: (...args) => errors.push(args.map(stringifyConsoleArg).join(' ')),
            warn: (...args) => logs.push(args.map(stringifyConsoleArg).join(' '))
        },
        prompt: () => readInput(),
        input: () => readInput(),
        Math,
        Date,
        JSON,
        Number,
        String,
        Boolean,
        Array,
        Object,
        RegExp,
        parseInt,
        parseFloat,
        isNaN,
        isFinite
    };

    const context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false }
    });

    try {
        const script = new vm.Script(code, { filename: 'user-code.js' });
        const result = script.runInContext(context, { timeout: 2000 });
        if (typeof result !== 'undefined') {
            logs.push(stringifyConsoleArg(result));
        }
    } catch (error) {
        errors.push(error && error.message ? error.message : 'Execution failed');
    }

    return {
        stdout: clipOutput(logs.join('\n')),
        stderr: clipOutput(errors.join('\n')),
        durationMs: Date.now() - start
    };
}

function validateCodeByLanguage(language, code) {
    const blockers = {
        javascript: [
            /\brequire\s*\(/,
            /\bprocess\b/,
            /\bFunction\s*\(/,
            /\beval\s*\(/,
            /\bimport\s*\(/,
            /\bglobalThis\b/,
            /\bXMLHttpRequest\b/,
            /\bfetch\s*\(/
        ],
        python: [
            /\bimport\s+os\b/,
            /\bimport\s+sys\b/,
            /\bimport\s+subprocess\b/,
            /\bimport\s+socket\b/,
            /\bfrom\s+os\s+import\b/,
            /\bfrom\s+subprocess\s+import\b/,
            /\bopen\s*\(/,
            /\bexec\s*\(/,
            /\beval\s*\(/,
            /\b__import__\s*\(/
        ],
        c: [
            /\bsystem\s*\(/,
            /\bfork\s*\(/,
            /\bexec[a-z]*\s*\(/,
            /\bpopen\s*\(/,
            /\bremove\s*\(/
        ],
        cpp: [
            /\bsystem\s*\(/,
            /\bfork\s*\(/,
            /\bexec[a-z]*\s*\(/,
            /\bpopen\s*\(/,
            /\bremove\s*\(/
        ],
        java: [
            /\bRuntime\.getRuntime\(\)\.exec\b/,
            /\bProcessBuilder\b/,
            /\bjava\.io\.File\b/,
            /\bjava\.nio\.file\b/,
            /\bSystem\.setProperty\b/
        ],
        go: [
            /\bos\/exec\b/,
            /\bexec\.Command\b/,
            /\bos\.Remove\b/,
            /\bos\.RemoveAll\b/,
            /\bos\.OpenFile\b/
        ],
        ruby: [
            /\brequire\s+['"]socket['"]/,
            /\brequire\s+['"]open3['"]/,
            /`[^`]*`/,
            /\bsystem\s*\(/,
            /\bexec\s*\(/,
            /\bIO\.popen\b/,
            /\bFile\.(?:delete|unlink|open)\b/
        ],
        php: [
            /\b(shell_exec|exec|system|passthru|proc_open|popen)\s*\(/,
            /\bcurl_init\s*\(/,
            /\bfsockopen\s*\(/,
            /\bfopen\s*\(/,
            /\bunlink\s*\(/
        ],
        csharp: [
            /\bSystem\.Diagnostics\.Process\b/,
            /\bProcess\.Start\b/,
            /\bSystem\.IO\.File\b/,
            /\bSystem\.IO\.Directory\b/,
            /\bSystem\.Net\b/,
            /\bDllImport\b/
        ],
        sql: [
            /\bATTACH\s+DATABASE\b/i,
            /\bDETACH\s+DATABASE\b/i,
            /\bLOAD_EXTENSION\b/i,
            /\bPRAGMA\s+.*\bjournal_mode\b/i
        ]
    };

    const rules = blockers[language] || [];
    for (const pattern of rules) {
        if (pattern.test(code)) {
            return { valid: false, message: 'Code contains restricted operations for safety.' };
        }
    }
    return { valid: true };
}

function runPythonInSandbox(code, stdinText = '') {
    return new Promise((resolve) => {
        const start = Date.now();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-py-'));
        const scriptFile = path.join(tempDir, 'script.py');
        const plotFile = path.join(tempDir, 'plot.png');
        const plotMarker = '__TEJAS_PLOT__:';
        const usesMatplotlib = /\bmatplotlib\b|\bpyplot\b|\bplt\./.test(code);
        const wrappedCode = usesMatplotlib
            ? `${code}

# Auto-capture plot output for browser preview in Code Lab.
try:
    import matplotlib.pyplot as __tejas_plt
    __tejas_figures = __tejas_plt.get_fignums()
    if __tejas_figures:
        __tejas_plt.savefig(r"${plotFile.replace(/\\/g, '\\\\')}", dpi=140, bbox_inches='tight')
        print("${plotMarker}${plotFile.replace(/\\/g, '\\\\')}")
except Exception:
    pass
`
            : code;

        fs.writeFileSync(scriptFile, wrappedCode, 'utf8');

        const child = spawn('python3', ['-I', scriptFile], {
            env: usesMatplotlib ? { ...process.env, MPLBACKEND: 'Agg' } : process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const cleanup = () => {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (error) {
                // Ignore cleanup errors.
            }
        };

        const finish = () => {
            if (settled) return;
            settled = true;
            let cleanStdout = stdout;
            let plotImage = '';

            if (usesMatplotlib) {
                const lines = String(stdout || '').split(/\r?\n/);
                const visibleLines = [];
                let plotPath = '';

                for (const line of lines) {
                    if (line.startsWith(plotMarker)) {
                        plotPath = line.slice(plotMarker.length).trim();
                    } else {
                        visibleLines.push(line);
                    }
                }

                cleanStdout = visibleLines.join('\n').replace(/\n+$/, '');
                if (plotPath && fs.existsSync(plotPath)) {
                    try {
                        const image = fs.readFileSync(plotPath);
                        plotImage = `data:image/png;base64,${image.toString('base64')}`;
                    } catch (error) {
                        // Ignore image read errors.
                    }
                }
            }

            resolve({
                stdout: clipOutput(cleanStdout),
                stderr: clipOutput(stderr),
                plotImage,
                durationMs: Date.now() - start
            });
            cleanup();
        };

        const timer = setTimeout(() => {
            stderr += (stderr ? '\n' : '') + 'Execution timed out.';
            child.kill('SIGKILL');
        }, 3000);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            stderr += (stderr ? '\n' : '') + (error.message || 'Python execution failed');
            clearTimeout(timer);
            finish();
        });
        child.on('close', () => {
            clearTimeout(timer);
            finish();
        });

        try {
            child.stdin.write(String(stdinText || ''));
            child.stdin.end();
        } catch (error) {
            // Ignore stdin write errors and continue.
        }
    });
}

function runProcess(command, args, options = {}) {
    const {
        cwd = process.cwd(),
        stdinText = '',
        timeoutMs = 3000
    } = options;

    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            resolve(payload);
        };

        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch (error) {
                // Ignore kill errors.
            }
            finish({
                code: null,
                stdout: clipOutput(stdout),
                stderr: clipOutput(`${stderr}${stderr ? '\n' : ''}Execution timed out.`),
                timedOut: true
            });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            const missingBinary = error && error.code === 'ENOENT';
            const friendlyError = missingBinary
                ? `${command} is not installed or not available in PATH on this server.`
                : (error && error.message ? error.message : 'Execution failed');
            clearTimeout(timer);
            finish({
                code: null,
                stdout: clipOutput(stdout),
                stderr: clipOutput(friendlyError),
                timedOut: false
            });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            finish({
                code,
                stdout: clipOutput(stdout),
                stderr: clipOutput(stderr),
                timedOut: false
            });
        });

        try {
            child.stdin.write(String(stdinText || ''));
            child.stdin.end();
        } catch (error) {
            // Ignore stdin write errors.
        }
    });
}

async function runCompiledCodeInSandbox(language, code, stdinText = '') {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-code-'));
    const extension = language === 'c' ? 'c' : 'cpp';
    const sourceFile = path.join(tempDir, `main.${extension}`);
    const outputFile = path.join(tempDir, 'app.out');
    const compiler = language === 'c' ? 'gcc' : 'g++';
    const compileArgs = language === 'c'
        ? [sourceFile, '-O0', '-std=c11', '-o', outputFile]
        : [sourceFile, '-O0', '-std=c++17', '-o', outputFile];

    try {
        fs.writeFileSync(sourceFile, code, 'utf8');
        const compileResult = await runProcess(compiler, compileArgs, {
            cwd: tempDir,
            timeoutMs: 5000
        });

        if (compileResult.code !== 0) {
            return {
                stdout: compileResult.stdout,
                stderr: compileResult.stderr || `${compiler} is unavailable or compilation failed.`,
                durationMs: Date.now() - start
            };
        }

        const runResult = await runProcess(outputFile, [], {
            cwd: tempDir,
            stdinText,
            timeoutMs: 2500
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'Compilation/execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

async function runJavaInSandbox(code, stdinText = '') {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-java-'));
    const publicClassMatch = code.match(/\bpublic\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    const anyClassMatch = code.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    let className = (publicClassMatch && publicClassMatch[1]) || (anyClassMatch && anyClassMatch[1]) || 'Main';
    let sourceFile = path.join(tempDir, `${className}.java`);

    try {
        fs.writeFileSync(sourceFile, code, 'utf8');
        let compileResult = await runProcess('javac', [sourceFile], {
            cwd: tempDir,
            timeoutMs: 6000
        });

        if (compileResult.code !== 0) {
            const compileErrorText = String(compileResult.stderr || '');
            const nameHint =
                compileErrorText.match(/should be declared in a file named\s+([A-Za-z_][A-Za-z0-9_]*)\.java/i) ||
                compileErrorText.match(/file named\s+([A-Za-z_][A-Za-z0-9_]*)\.java/i) ||
                compileErrorText.match(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s+is public/i);
            if (nameHint && nameHint[1] && nameHint[1] !== className) {
                className = nameHint[1];
                sourceFile = path.join(tempDir, `${className}.java`);
                fs.writeFileSync(sourceFile, code, 'utf8');
                compileResult = await runProcess('javac', [sourceFile], {
                    cwd: tempDir,
                    timeoutMs: 6000
                });
            }
        }

        if (compileResult.code !== 0) {
            return {
                stdout: compileResult.stdout,
                stderr: compileResult.stderr || 'javac is unavailable or compilation failed.',
                durationMs: Date.now() - start
            };
        }

        const runResult = await runProcess('java', ['-cp', tempDir, className], {
            cwd: tempDir,
            stdinText,
            timeoutMs: 3000
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'Java execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

async function runGoInSandbox(code, stdinText = '') {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-go-'));
    const sourceFile = path.join(tempDir, 'main.go');

    try {
        fs.writeFileSync(sourceFile, code, 'utf8');
        const runResult = await runProcess('go', ['run', sourceFile], {
            cwd: tempDir,
            stdinText,
            timeoutMs: 5000
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'Go execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

async function runRubyInSandbox(code, stdinText = '') {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-ruby-'));
    const sourceFile = path.join(tempDir, 'main.rb');

    try {
        fs.writeFileSync(sourceFile, code, 'utf8');
        const runResult = await runProcess('ruby', [sourceFile], {
            cwd: tempDir,
            stdinText,
            timeoutMs: 4000
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'Ruby execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

async function runPhpInSandbox(code, stdinText = '') {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-php-'));
    const sourceFile = path.join(tempDir, 'main.php');

    try {
        fs.writeFileSync(sourceFile, code, 'utf8');
        const runResult = await runProcess('php', [sourceFile], {
            cwd: tempDir,
            stdinText,
            timeoutMs: 4000
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'PHP execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

async function runCSharpInSandbox(code, stdinText = '') {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-csharp-'));
    const sourceFile = path.join(tempDir, 'Program.cs');
    const outputFile = path.join(tempDir, 'app.exe');

    try {
        fs.writeFileSync(sourceFile, code, 'utf8');

        let compileResult = await runProcess('mcs', [sourceFile, '-out:' + outputFile], {
            cwd: tempDir,
            timeoutMs: 6000
        });

        if (compileResult.code !== 0) {
            compileResult = await runProcess('csc', [sourceFile, '/out:' + outputFile], {
                cwd: tempDir,
                timeoutMs: 6000
            });
        }

        if (compileResult.code !== 0) {
            return {
                stdout: compileResult.stdout,
                stderr: compileResult.stderr || 'C# compiler is unavailable or compilation failed.',
                durationMs: Date.now() - start
            };
        }

        const runResult = await runProcess('mono', [outputFile], {
            cwd: tempDir,
            stdinText,
            timeoutMs: 4000
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'C# execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

async function runSqlInSandbox(code) {
    const start = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tejas-sql-'));
    const runnerFile = path.join(tempDir, 'runner.py');
    const sqlFile = path.join(tempDir, 'query.sql');

    const runnerScript = `
import re
import sqlite3
import sys

sql_path = sys.argv[1]
with open(sql_path, "r", encoding="utf-8") as f:
    sql = f.read()

conn = sqlite3.connect(":memory:")
cur = conn.cursor()
buffer = ""
outputs = []

def print_rows(description, rows):
    cols = [d[0] for d in description] if description else []
    if cols:
        outputs.append(" | ".join(cols))
        outputs.append("-" * max(3, len(" | ".join(cols))))
    for row in rows[:200]:
        outputs.append(" | ".join("" if v is None else str(v) for v in row))
    if len(rows) > 200:
        outputs.append(f"... ({len(rows) - 200} more rows)")

def run_and_print(query):
    cur.execute(query)
    rows = cur.fetchall()
    print_rows(cur.description, rows)

def handle_show_describe(stmt):
    upper = stmt.upper().strip()

    if upper == "SHOW TABLES":
        run_and_print("SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        return True

    if upper == "SHOW DATABASES":
        run_and_print("SELECT 'main' AS database_name")
        return True

    m = re.match(r"^SHOW\\s+COLUMNS\\s+(?:FROM|IN)\\s+([A-Za-z_][A-Za-z0-9_]*)$", stmt, flags=re.IGNORECASE)
    if m:
        table = m.group(1)
        run_and_print(f"PRAGMA table_info({table})")
        return True

    m = re.match(r"^DESCRIBE\\s+([A-Za-z_][A-Za-z0-9_]*)$", stmt, flags=re.IGNORECASE)
    if m:
        table = m.group(1)
        run_and_print(f"PRAGMA table_info({table})")
        return True

    return False

def execute_statement(stmt):
    if handle_show_describe(stmt):
        return

    cur.execute(stmt)
    keyword = stmt.split(None, 1)[0].upper() if stmt.split(None, 1) else ""
    if keyword in ("SELECT", "PRAGMA", "WITH", "EXPLAIN"):
        rows = cur.fetchall()
        print_rows(cur.description, rows)
    else:
        conn.commit()
        outputs.append(f"OK: {keyword or 'STATEMENT'} (changes: {conn.total_changes})")

try:
    for ch in sql:
        buffer += ch
        if not sqlite3.complete_statement(buffer):
            continue
        stmt = buffer.strip()
        buffer = ""
        if not stmt:
            continue
        if stmt.endswith(";"):
            stmt = stmt[:-1].strip()
        if not stmt:
            continue
        execute_statement(stmt)

    if buffer.strip():
        execute_statement(buffer.strip())

    print("\\n".join(outputs))
except sqlite3.Error as err:
    msg = str(err)
    print("SQLite Error: " + msg, file=sys.stderr)
    if "near \\"show\\"" in msg.lower():
        print("Tip: Use SQLite syntax, or supported aliases: SHOW TABLES, SHOW DATABASES, SHOW COLUMNS FROM <table>, DESCRIBE <table>.", file=sys.stderr)
    sys.exit(1)
`.trim();

    try {
        fs.writeFileSync(sqlFile, code, 'utf8');
        fs.writeFileSync(runnerFile, runnerScript, 'utf8');
        const runResult = await runProcess('python3', ['-I', runnerFile, sqlFile], {
            cwd: tempDir,
            timeoutMs: 4500
        });

        return {
            stdout: runResult.stdout,
            stderr: runResult.stderr,
            durationMs: Date.now() - start
        };
    } catch (error) {
        return {
            stdout: '',
            stderr: error && error.message ? error.message : 'SQL execution failed',
            durationMs: Date.now() - start
        };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors.
        }
    }
}

// API Routes

// Public app config for frontend
app.get('/api/config', (req, res) => {
    res.json({
        googleClientId: GOOGLE_CLIENT_ID
    });
});

// Client-side session guard for logged-in users
app.post('/api/user/session-status', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
        return res.status(400).json({
            success: false,
            valid: false,
            message: 'Email is required'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === email);
    if (!user) {
        return res.json({
            success: true,
            valid: false,
            reason: 'deleted'
        });
    }

    if (user.accountStatus === 'blocked') {
        return res.json({
            success: true,
            valid: false,
            reason: 'blocked'
        });
    }

    return res.json({
        success: true,
        valid: true
    });
});

app.get('/api/code/languages', (req, res) => {
    res.json([
        { id: 'javascript', label: 'JavaScript (Sandbox)' },
        { id: 'python', label: 'Python (Restricted)' },
        { id: 'c', label: 'C (Compile & Run)' },
        { id: 'cpp', label: 'C++ (Compile & Run)' },
        { id: 'java', label: 'Java (Compile & Run)' },
        { id: 'go', label: 'Go (Run)' },
        { id: 'ruby', label: 'Ruby (Run)' },
        { id: 'php', label: 'PHP (Run)' },
        { id: 'csharp', label: 'C# (Compile & Run)' },
        { id: 'sql', label: 'SQL (SQLite In-Memory)' }
    ]);
});

app.post('/api/code/run', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const language = String(req.body?.language || 'javascript').trim().toLowerCase();
    const code = String(req.body?.code || '');
    const stdinText = String(req.body?.stdin || '');

    if (!email) {
        return res.status(400).json({
            success: false,
            message: 'Login required'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === email);
    if (!user) {
        return res.status(401).json({
            success: false,
            message: 'User not found. Please login again.'
        });
    }
    if (user.accountStatus === 'blocked') {
        return res.status(403).json({
            success: false,
            message: 'Your account is blocked by admin.'
        });
    }

    if (!['javascript', 'python', 'c', 'cpp', 'java', 'go', 'ruby', 'php', 'csharp', 'sql'].includes(language)) {
        return res.status(400).json({
            success: false,
            message: 'Unsupported language.'
        });
    }
    if (!code.trim()) {
        return res.status(400).json({
            success: false,
            message: 'Code cannot be empty.'
        });
    }
    if (code.length > 20000) {
        return res.status(400).json({
            success: false,
            message: 'Code length exceeds allowed limit.'
        });
    }

    const codeValidation = validateCodeByLanguage(language, code);
    if (!codeValidation.valid) {
        return res.status(400).json({
            success: false,
            message: codeValidation.message
        });
    }

    let result;
    if (language === 'javascript') {
        result = runJavaScriptInSandbox(code, stdinText);
    } else if (language === 'python') {
        result = await runPythonInSandbox(code, stdinText);
    } else if (language === 'java') {
        result = await runJavaInSandbox(code, stdinText);
    } else if (language === 'go') {
        result = await runGoInSandbox(code, stdinText);
    } else if (language === 'ruby') {
        result = await runRubyInSandbox(code, stdinText);
    } else if (language === 'php') {
        result = await runPhpInSandbox(code, stdinText);
    } else if (language === 'csharp') {
        result = await runCSharpInSandbox(code, stdinText);
    } else if (language === 'sql') {
        result = await runSqlInSandbox(code);
    } else {
        result = await runCompiledCodeInSandbox(language, code, stdinText);
    }
    return res.json({
        success: true,
        language,
        ...result
    });
});

// Public announcement for website notice bar
app.get('/api/announcement', (req, res) => {
    if (!isAnnouncementLive(announcementState)) {
        return res.json({ active: false });
    }
    return res.json({
        active: true,
        title: announcementState.title || '',
        message: announcementState.message,
        type: announcementState.type,
        ctaText: announcementState.ctaText || '',
        ctaUrl: announcementState.ctaUrl || '',
        startsAt: announcementState.startsAt || '',
        endsAt: announcementState.endsAt || '',
        dismissible: announcementState.dismissible !== false,
        updatedAt: announcementState.updatedAt
    });
});

// Register new user
app.post('/api/register', (req, res) => {
    const { firstName, lastName, email, phone, course, password } = req.body;
    
    // Validation
    if (!firstName || !email || !phone || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'First name, email, phone, and password are required' 
        });
    }
    
    // Check if user already exists
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
        return res.status(400).json({ 
            success: false, 
            message: 'User with this email already exists' 
        });
    }
    
    const normalizedCourse = typeof course === 'string' ? course.trim() : '';
    const newUser = {
        id: users.length + 1,
        firstName,
        lastName: lastName || '',
        email,
        phone,
        course: normalizedCourse,
        enrolledCourses: [],
        gamification: normalizeGamification({}),
        accountStatus: 'active',
        password, // In production, hash the password!
        createdAt: new Date().toISOString()
    };
    
    users.push(newUser);
    saveData(usersFile, users);
    
    console.log('New User Registered:', { ...newUser, password: '***' });
    
    res.json({ 
        success: true, 
        message: 'Registration successful! Please login.' 
    });
});

// Login user
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
        return res.status(400).json({ 
            success: false, 
            message: 'Email and password are required' 
        });
    }
    
    // Find user
    const user = users.find(u => u.email === email && u.password === password);
    
    if (!user) {
        return res.status(401).json({ 
            success: false, 
            message: 'Invalid email or password' 
        });
    }

    if (user.accountStatus === 'blocked') {
        return res.status(403).json({
            success: false,
            message: 'Your account is blocked. Please contact institute administration.'
        });
    }
    
    // Return user without password
    Object.assign(user, normalizeUserEnrollment(user));
    touchDailyStreak(user);
    applyBadges(user);
    saveData(usersFile, users);
    const userWithoutPassword = toClientUser(user);
    
    console.log('User Logged In:', userWithoutPassword);
    
    res.json({ 
        success: true, 
        message: 'Login successful!',
        user: userWithoutPassword
    });
});

// Google login
app.post('/api/auth/google', async (req, res) => {
    const { credential } = req.body;

    if (!credential) {
        return res.status(400).json({
            success: false,
            message: 'Google credential is required'
        });
    }

    if (!GOOGLE_CLIENT_ID) {
        return res.status(500).json({
            success: false,
            message: 'Google login is not configured on server'
        });
    }

    try {
        const tokenInfoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
        const tokenInfo = await tokenInfoResponse.json();

        if (!tokenInfoResponse.ok) {
            return res.status(401).json({
                success: false,
                message: 'Invalid Google token'
            });
        }

        if (tokenInfo.aud !== GOOGLE_CLIENT_ID) {
            return res.status(401).json({
                success: false,
                message: 'Google token audience mismatch'
            });
        }

        if (tokenInfo.email_verified !== 'true') {
            return res.status(401).json({
                success: false,
                message: 'Google email is not verified'
            });
        }

        const email = tokenInfo.email;
        let user = users.find(u => u.email === email);

        if (!user) {
            const fullName = (tokenInfo.name || '').trim();
            const nameParts = fullName.split(' ').filter(Boolean);
            const firstName = nameParts[0] || 'Google';
            const lastName = nameParts.slice(1).join(' ');

            user = {
                id: users.length + 1,
                firstName,
                lastName,
                email,
                phone: '',
                course: '',
                accountStatus: 'active',
                password: '',
                authProvider: 'google',
                createdAt: new Date().toISOString()
            };

            users.push(user);
            saveData(usersFile, users);
        }

        Object.assign(user, normalizeUserEnrollment(user));
        if (user.accountStatus === 'blocked') {
            return res.status(403).json({
                success: false,
                message: 'Your account is blocked. Please contact institute administration.'
            });
        }
        touchDailyStreak(user);
        applyBadges(user);
        saveData(usersFile, users);
        const userWithoutPassword = toClientUser(user);
        return res.json({
            success: true,
            message: 'Google login successful!',
            user: userWithoutPassword
        });
    } catch (error) {
        console.error('Google login error:', error);
        return res.status(500).json({
            success: false,
            message: 'Google login failed. Please try again.'
        });
    }
});

app.post('/api/users/enroll', (req, res) => {
    const { email, courseIdentifier, courseTitle } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!normalizedEmail) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    const identifier = String(courseIdentifier || '').trim();
    let course = identifier ? getCourseByIdentifier(identifier) : null;
    if (!course && courseTitle) {
        const titleSlug = slugifyCourse(String(courseTitle));
        course = getCourseByIdentifier(titleSlug);
    }

    if (!course) {
        return res.status(404).json({
            success: false,
            message: 'Course not found'
        });
    }

    const normalizedUser = normalizeUserEnrollment(user);
    const alreadyEnrolled = normalizedUser.enrolledCourses.some(entry => entry.slug === course.slug);
    if (!alreadyEnrolled) {
        normalizedUser.enrolledCourses.push({ title: course.title, slug: course.slug });
        addXp(normalizedUser, gamificationConfig.rewards.enrollXp);
    }

    touchDailyStreak(normalizedUser);
    applyBadges(normalizedUser);
    normalizedUser.course = course.title;
    Object.assign(user, normalizedUser);
    saveData(usersFile, users);

    return res.json({
        success: true,
        message: alreadyEnrolled ? 'Course already enrolled' : 'Enrollment successful',
        enrolledCourse: { title: course.title, slug: course.slug },
        user: toClientUser(user)
    });
});

app.post('/api/users/progress', (req, res) => {
    const {
        email,
        courseSlug,
        courseTitle,
        completedCount,
        totalTopics,
        percent
    } = req.body || {};

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedSlug = String(courseSlug || '').trim();
    const normalizedTitle = String(courseTitle || '').trim();

    if (!normalizedEmail || !normalizedSlug) {
        return res.status(400).json({
            success: false,
            message: 'Email and courseSlug are required'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    const normalizedUser = normalizeUserEnrollment(user);
    const gamification = ensureGamification(normalizedUser);
    const prevProgress = gamification.progressByCourse[normalizedSlug] || {
        completedCount: 0,
        totalTopics: 0,
        percent: 0
    };

    const nextCompletedCount = Math.max(0, Number(completedCount) || 0);
    const nextTotalTopics = Math.max(nextCompletedCount, Number(totalTopics) || 0);
    const computedPercent = nextTotalTopics
        ? Math.round((nextCompletedCount / nextTotalTopics) * 100)
        : 0;
    const nextPercent = Math.min(100, Math.max(0, Number.isFinite(Number(percent)) ? Number(percent) : computedPercent));

    const completionDelta = Math.max(0, nextCompletedCount - (prevProgress.completedCount || 0));
    const gainedFromTopics = addXp(normalizedUser, completionDelta * gamificationConfig.rewards.topicXp);
    const prevPercent = Math.max(0, Number(prevProgress.percent) || 0);
    const completionBonus = nextPercent >= 100 && prevPercent < 100 ? addXp(normalizedUser, gamificationConfig.rewards.completionXp) : 0;
    const streakXp = completionDelta > 0 ? touchDailyStreak(normalizedUser) : 0;
    const weeklyXp = completionDelta > 0 ? applyWeeklyChallenge(normalizedUser, completionDelta) : 0;

    gamification.progressByCourse[normalizedSlug] = {
        courseSlug: normalizedSlug,
        courseTitle: normalizedTitle,
        completedCount: nextCompletedCount,
        totalTopics: nextTotalTopics,
        percent: nextPercent,
        updatedAt: new Date().toISOString()
    };

    applyBadges(normalizedUser);
    Object.assign(user, normalizedUser);
    saveData(usersFile, users);

    return res.json({
        success: true,
        xpGained: gainedFromTopics + completionBonus + streakXp + weeklyXp,
        summary: getGamificationSummary(user),
        user: toClientUser(user)
    });
});

app.get('/api/gamification/summary', (req, res) => {
    const normalizedEmail = String(req.query.email || '').trim().toLowerCase();
    if (!normalizedEmail) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    Object.assign(user, normalizeUserEnrollment(user));
    applyBadges(user);
    saveData(usersFile, users);

    return res.json({
        success: true,
        summary: {
            ...getGamificationSummary(user),
            ...computeRankForEmail(normalizedEmail)
        }
    });
});

app.get('/api/gamification/leaderboard', (req, res) => {
    const currentEmail = String(req.query.email || '').trim().toLowerCase();
    const list = users
        .map(user => normalizeUserEnrollment(user))
        .map(user => {
            const gamification = ensureGamification(user);
            return {
                name: `${String(user.firstName || '').trim()} ${String(user.lastName || '').trim()}`.trim() || String(user.email || ''),
                email: String(user.email || '').trim().toLowerCase(),
                xp: gamification.xp,
                level: gamification.level,
                streak: gamification.streakCurrent,
                badges: (gamification.badges || []).length
            };
        })
        .sort((a, b) => (b.xp - a.xp) || (b.streak - a.streak) || a.name.localeCompare(b.name))
        .slice(0, 25)
        .map((entry, index) => ({
            rank: index + 1,
            ...entry,
            currentUser: Boolean(currentEmail && entry.email === currentEmail)
        }));

    return res.json({
        success: true,
        leaderboard: list
    });
});

app.get('/api/mentor/brief', (req, res) => {
    const normalizedEmail = String(req.query.email || '').trim().toLowerCase();
    if (!normalizedEmail) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    Object.assign(user, normalizeUserEnrollment(user));
    const mentor = buildMentorMessage(user);
    const reminder = getOrCreateDailyMentorReminder(user);
    saveData(usersFile, users);

    return res.json({
        success: true,
        mentor: {
            ...mentor,
            reminder
        }
    });
});

app.post('/api/mentor/chat', async (req, res) => {
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    const message = String(req.body?.message || '').trim();

    if (!normalizedEmail) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }
    if (!message) {
        return res.status(400).json({
            success: false,
            message: 'Message is required'
        });
    }
    if (message.length > 500) {
        return res.status(400).json({
            success: false,
            message: 'Message is too long.'
        });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    Object.assign(user, normalizeUserEnrollment(user));
    const chatFromGemini = await getGeminiMentorReply(user, message);
    const chatFromGpt = chatFromGemini ? null : await getChatGptMentorReply(user, message);
    const chat = chatFromGemini || chatFromGpt || {
        ...generateMentorChatReply(user, message),
        provider: 'local'
    };

    const currentMentorState = user.aiMentor && typeof user.aiMentor === 'object' ? user.aiMentor : {};
    const history = Array.isArray(currentMentorState.history) ? currentMentorState.history : [];
    history.push({
        question: message,
        reply: chat.reply,
        createdAt: new Date().toISOString()
    });
    currentMentorState.history = history.slice(-20);
    user.aiMentor = currentMentorState;
    saveData(usersFile, users);

    return res.json({
        success: true,
        reply: chat.reply,
        suggestions: chat.suggestions,
        provider: chat.provider
    });
});

app.post('/api/website-assistant/chat', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) {
        return res.status(400).json({
            success: false,
            message: 'Message is required'
        });
    }
    if (message.length > 500) {
        return res.status(400).json({
            success: false,
            message: 'Message is too long.'
        });
    }

    const geminiReply = await getGeminiWebsiteReply(message);
    const openAiReply = geminiReply ? null : await getChatGptWebsiteReply(message);
    const fallback = generateWebsiteAssistantFallback(message);
    const payload = geminiReply || openAiReply || fallback;

    return res.json({
        success: true,
        answer: payload.answer,
        suggestions: Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 3) : fallback.suggestions,
        provider: geminiReply ? 'gemini' : (openAiReply ? 'chatgpt' : 'local')
    });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username and password are required'
        });
    }

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        return res.status(401).json({
            success: false,
            message: 'Invalid admin credentials'
        });
    }

    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, { username, createdAt: new Date().toISOString() });

    res.json({
        success: true,
        message: 'Admin login successful',
        token
    });
});

// Validate admin session
app.get('/api/admin/session', requireAdminAuth, (req, res) => {
    res.json({ success: true });
});

// Admin logout
app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
    const token = getBearerToken(req);
    adminSessions.delete(token);
    res.json({ success: true, message: 'Logged out successfully' });
});

// Get/update announcement (admin)
app.get('/api/admin/announcement', requireAdminAuth, (req, res) => {
    const normalized = normalizeAnnouncement({
        ...announcementState,
        updatedAt: announcementState.updatedAt || new Date().toISOString()
    });
    normalized.updatedAt = announcementState.updatedAt || normalized.updatedAt;
    res.json(normalized);
});

app.put('/api/admin/announcement', requireAdminAuth, (req, res) => {
    const next = normalizeAnnouncement(req.body);
    announcementState.title = next.title;
    announcementState.message = next.message;
    announcementState.type = next.type;
    announcementState.active = next.active;
    announcementState.ctaText = next.ctaText;
    announcementState.ctaUrl = next.ctaUrl;
    announcementState.startsAt = next.startsAt;
    announcementState.endsAt = next.endsAt;
    announcementState.dismissible = next.dismissible;
    announcementState.updatedAt = next.updatedAt;
    saveData(announcementFile, announcementState);

    res.json({
        success: true,
        message: 'Announcement updated successfully',
        announcement: announcementState
    });
});

app.get('/api/admin/gamification-config', requireAdminAuth, (req, res) => {
    res.json({
        success: true,
        config: gamificationConfig
    });
});

app.put('/api/admin/gamification-config', requireAdminAuth, (req, res) => {
    const next = normalizeGamificationConfig(req.body || {});
    gamificationConfig = next;
    saveData(gamificationConfigFile, gamificationConfig);
    return res.json({
        success: true,
        message: 'Gamification settings updated.',
        config: gamificationConfig
    });
});

app.get('/api/admin/course-pricing', requireAdminAuth, (req, res) => {
    const courses = getCoursesCatalog()
        .map(course => ({
            id: course.id,
            title: course.title,
            slug: course.slug,
            duration: course.duration,
            level: course.level,
            price: course.price,
            priceLabel: course.priceLabel
        }))
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

    return res.json({
        success: true,
        courses
    });
});

app.put('/api/admin/course-pricing/:identifier', requireAdminAuth, (req, res) => {
    const identifier = String(req.params.identifier || '').trim();
    const price = Number(req.body?.price);

    if (!identifier) {
        return res.status(400).json({
            success: false,
            message: 'Course identifier is required.'
        });
    }

    if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
            success: false,
            message: 'Price must be a positive number.'
        });
    }

    const course = getCourseByIdentifier(identifier);
    if (!course) {
        return res.status(404).json({
            success: false,
            message: 'Course not found.'
        });
    }

    const nextPrice = Math.round(price);
    coursePricingOverrides[course.slug] = nextPrice;
    saveData(coursePricingFile, coursePricingOverrides);

    return res.json({
        success: true,
        message: 'Course price updated successfully.',
        course: {
            id: course.id,
            title: course.title,
            slug: course.slug,
            price: nextPrice,
            priceLabel: formatInrPrice(nextPrice)
        }
    });
});

// Quick insights for admin panel
app.get('/api/admin/insights', requireAdminAuth, (req, res) => {
    const topCourse = getTopCourseDemand();
    const today = new Date().toDateString();
    const todayLeads = inquiries.filter(i => new Date(i.date).toDateString() === today).length;
    const todayRegistrations = users.filter(u => new Date(u.createdAt).toDateString() === today).length;

    res.json({
        topCourse,
        todayLeads,
        todayRegistrations
    });
});

// Get all users (for admin)
app.get('/api/users', requireAdminAuth, (req, res) => {
    const usersWithoutPassword = users.map(u => toClientUser(u));
    res.json(usersWithoutPassword);
});

// Update a user (for admin)
app.put('/api/users/:id', requireAdminAuth, (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid user id'
        });
    }

    const userIndex = users.findIndex(u => Number(u.id) === userId);
    if (userIndex === -1) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    const payload = req.body || {};
    const user = users[userIndex];
    const nextFirstName = typeof payload.firstName === 'string' ? payload.firstName.trim() : user.firstName;
    const nextLastName = typeof payload.lastName === 'string' ? payload.lastName.trim() : user.lastName;
    const nextPhone = typeof payload.phone === 'string' ? payload.phone.trim() : user.phone;
    const nextCourse = typeof payload.course === 'string' ? payload.course.trim() : user.course;

    if (!nextFirstName) {
        return res.status(400).json({
            success: false,
            message: 'First name is required'
        });
    }

    const nextStatus = payload.accountStatus === 'blocked' ? 'blocked' : 'active';
    const updated = normalizeUserEnrollment({
        ...user,
        firstName: nextFirstName,
        lastName: nextLastName,
        phone: nextPhone,
        course: nextCourse,
        accountStatus: nextStatus
    });

    users[userIndex] = updated;
    saveData(usersFile, users);

    return res.json({
        success: true,
        message: 'User updated successfully',
        user: toClientUser(updated)
    });
});

// Delete a user (for admin)
function handleDeleteUser(req, res) {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid user id'
        });
    }

    const userIndex = users.findIndex(u => Number(u.id) === userId);
    if (userIndex === -1) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    const [removedUser] = users.splice(userIndex, 1);
    saveData(usersFile, users);

    return res.json({
        success: true,
        message: 'User deleted successfully',
        user: toClientUser(removedUser)
    });
}

app.delete('/api/users/:id', requireAdminAuth, handleDeleteUser);
app.post('/api/users/:id/delete', requireAdminAuth, handleDeleteUser);

// API Routes

// Build complete course catalog with details
function getCoursesCatalog() {
    const courses = [
        {
            id: 1,
            title: 'Python Programming',
            description: 'Learn Python from basics to advanced concepts including Django framework',
            duration: '3 months',
            level: 'Beginner to Advanced',
            icon: 'fab fa-python',
            image: 'https://images.unsplash.com/photo-1526379095098-d400fd0bf935?w=400'
        },
        {
            id: 2,
            title: 'Java Programming',
            description: 'Master Java programming with OOP concepts and real-world applications',
            duration: '4 months',
            level: 'Beginner to Advanced',
            icon: 'fab fa-java',
            image: 'https://images.unsplash.com/photo-1629654297299-c8506221ca97?w=400'
        },
        {
            id: 3,
            title: 'C++ Programming',
            description: 'Learn C++ for system programming and competitive coding',
            duration: '3 months',
            level: 'Beginner to Advanced',
            icon: 'fas fa-code',
            image: 'https://images.unsplash.com/photo-1515879218367-8466d910aaa4?w=400'
        },
        {
            id: 4,
            title: 'Data Science & AI',
            description: 'Master data analysis, machine learning, and artificial intelligence',
            duration: '6 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-brain',
            image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400'
        },
        {
            id: 5,
            title: 'Web Development',
            description: 'Full stack web development with HTML, CSS, JavaScript, React, and Node.js',
            duration: '6 months',
            level: 'Beginner to Advanced',
            icon: 'fas fa-globe',
            image: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=400'
        },
        {
            id: 6,
            title: 'Basic Computer & MS Office',
            description: 'Computer fundamentals, MS Word, Excel, PowerPoint, and Internet',
            duration: '2 months',
            level: 'Beginner',
            icon: 'fas fa-laptop',
            image: 'https://images.unsplash.com/photo-1531297484001-80022131f5a1?w=400'
        },
        {
            id: 7,
            title: 'Tally Prime & GST',
            description: 'Accounting software training with GST concepts and tax returns',
            duration: '2 months',
            level: 'Beginner',
            icon: 'fas fa-calculator',
            image: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=400'
        },
        {
            id: 8,
            title: 'Digital Skills',
            description: 'Digital marketing, social media, and online business skills',
            duration: '2 months',
            level: 'Beginner',
            icon: 'fas fa-bullhorn',
            image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400'
        },
        {
            id: 9,
            title: 'C Programming',
            description: 'Learn C programming language for system-level programming',
            duration: '2 months',
            level: 'Beginner to Intermediate',
            icon: 'fas fa-code',
            image: 'https://images.unsplash.com/photo-1515879218367-8466d910aaa4?w=400'
        },
        {
            id: 10,
            title: 'JavaScript & React',
            description: 'Modern JavaScript and React.js for building interactive web applications',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fab fa-react',
            image: 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=400'
        },
        {
            id: 11,
            title: 'Machine Learning',
            description: 'Build ML models and understand neural networks with TensorFlow',
            duration: '6 months',
            level: 'Advanced',
            icon: 'fas fa-network-wired',
            image: 'https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=400'
        },
        {
            id: 12,
            title: 'Database Management (SQL)',
            description: 'Master MySQL, PostgreSQL, and database design concepts',
            duration: '3 months',
            level: 'Beginner to Intermediate',
            icon: 'fas fa-database',
            image: 'https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=400'
        },
        {
            id: 13,
            title: 'Cloud Computing (AWS)',
            description: 'Learn Amazon Web Services for cloud deployment and infrastructure',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-cloud',
            image: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400'
        },
        {
            id: 14,
            title: 'Mobile App Development',
            description: 'Build Android and iOS apps using Flutter and React Native',
            duration: '6 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-mobile-alt',
            image: 'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=400'
        },
        {
            id: 15,
            title: 'DevOps & Docker',
            description: 'Learn DevOps practices, Docker containers, and CI/CD pipelines',
            duration: '3 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-cube',
            image: 'https://images.unsplash.com/photo-1605745341112-85968b19335b?w=400'
        },
        {
            id: 16,
            title: 'Cyber Security',
            description: 'Understand network security, ethical hacking, and cyber protection',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-shield-alt',
            image: 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=400'
        },
        {
            id: 17,
            title: 'Data Structures & Algorithms',
            description: 'Master DSA for competitive programming and technical interviews',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-sitemap',
            image: 'https://images.unsplash.com/photo-1509228468518-180dd4864904?w=400'
        },
        {
            id: 18,
            title: 'PHP & MySQL',
            description: 'Server-side programming with PHP and MySQL database',
            duration: '3 months',
            level: 'Beginner to Intermediate',
            icon: 'fab fa-php',
            image: 'https://images.unsplash.com/photo-1627398242454-45a1465c2479?w=400'
        },
        {
            id: 19,
            title: 'Angular Development',
            description: 'Build enterprise web applications with Angular framework',
            duration: '3 months',
            level: 'Intermediate to Advanced',
            icon: 'fab fa-angular',
            image: 'https://images.unsplash.com/photo-1614741118887-7a4ee193a5fa?w=400'
        },
        {
            id: 20,
            title: 'UI/UX Design',
            description: 'Learn Figma, Adobe XD for designing user interfaces and experiences',
            duration: '3 months',
            level: 'Beginner to Intermediate',
            icon: 'fas fa-paint-brush',
            image: 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=400'
        },
        {
            id: 21,
            title: 'Software Testing',
            description: 'Manual and automation testing with Selenium and JMeter',
            duration: '3 months',
            level: 'Beginner to Intermediate',
            icon: 'fas fa-bug',
            image: 'https://images.unsplash.com/photo-1516110833967-0b5716ca1387?w=400'
        },
        {
            id: 22,
            title: 'Blockchain Development',
            description: 'Learn blockchain fundamentals and build decentralized apps',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-link',
            image: 'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=400'
        },
        {
            id: 23,
            title: 'Generative AI & Prompt Engineering',
            description: 'Build practical AI workflows using LLM tools, prompt design, and automation',
            duration: '3 months',
            level: 'Beginner to Intermediate',
            icon: 'fas fa-wand-magic-sparkles',
            image: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=400'
        },
        {
            id: 24,
            title: 'MERN Stack Development',
            description: 'Master MongoDB, Express, React, and Node.js for full-stack web apps',
            duration: '5 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-layer-group',
            image: 'https://images.unsplash.com/photo-1518773553398-650c184e0bb3?w=400'
        },
        {
            id: 25,
            title: 'Django Full Stack',
            description: 'Develop production-grade applications with Django, APIs, and frontend integration',
            duration: '4 months',
            level: 'Intermediate',
            icon: 'fab fa-python',
            image: 'https://images.unsplash.com/photo-1526379095098-d400fd0bf935?w=400'
        },
        {
            id: 26,
            title: 'Power BI & Data Visualization',
            description: 'Create interactive dashboards and business reports with Power BI',
            duration: '2 months',
            level: 'Beginner to Intermediate',
            icon: 'fas fa-chart-column',
            image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400'
        },
        {
            id: 27,
            title: 'Linux & Shell Scripting',
            description: 'Learn Linux administration, bash scripting, and server fundamentals',
            duration: '2 months',
            level: 'Beginner to Intermediate',
            icon: 'fab fa-linux',
            image: 'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=400'
        },
        {
            id: 28,
            title: 'Spring Boot Microservices',
            description: 'Build scalable microservices architecture with Spring Boot and APIs',
            duration: '4 months',
            level: 'Advanced',
            icon: 'fas fa-diagram-project',
            image: 'https://images.unsplash.com/photo-1516387938699-a93567ec168e?w=400'
        },
        {
            id: 29,
            title: 'Flutter App Development',
            description: 'Create cross-platform mobile apps with Flutter and Firebase integration',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-mobile-screen-button',
            image: 'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=400'
        },
        {
            id: 30,
            title: 'Ethical Hacking & Pen Testing',
            description: 'Hands-on penetration testing, vulnerability analysis, and security hardening',
            duration: '4 months',
            level: 'Intermediate to Advanced',
            icon: 'fas fa-user-shield',
            image: 'https://images.unsplash.com/photo-1563206767-5b18f218e8de?w=400'
        }
    ];
    return courses.map(enrichCourse);
}

// Get all courses
app.get('/api/courses', (req, res) => {
    res.json(getCoursesCatalog());
});

app.get('/api/practice/challenges', (req, res) => {
    const difficulty = String(req.query.difficulty || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim().toLowerCase();
    const search = String(req.query.search || '').trim().toLowerCase();
    const interviewOnly = String(req.query.interview || '').trim().toLowerCase() === 'true';

    const list = getPracticeChallengeSummary().filter(item => {
        const matchDifficulty = !difficulty || String(item.difficulty || '').toLowerCase() === difficulty;
        const matchCategory = !category || String(item.category || '').toLowerCase() === category;
        const matchInterview = !interviewOnly || Boolean(item.interview);
        const blob = `${item.title} ${item.category} ${(item.tags || []).join(' ')}`.toLowerCase();
        const matchSearch = !search || blob.includes(search);
        return matchDifficulty && matchCategory && matchInterview && matchSearch;
    });

    return res.json({
        success: true,
        challenges: list
    });
});

app.get('/api/practice/challenges/:id', (req, res) => {
    const challenge = getPracticeChallengeById(req.params.id);
    if (!challenge) {
        return res.status(404).json({
            success: false,
            message: 'Challenge not found.'
        });
    }

    return res.json({
        success: true,
        challenge: {
            id: challenge.id,
            title: challenge.title,
            difficulty: challenge.difficulty,
            category: challenge.category,
            interview: Boolean(challenge.interview),
            tags: challenge.tags || [],
            statement: challenge.statement,
            constraints: challenge.constraints || [],
            examples: challenge.examples || [],
            starterCode: challenge.starterCode || {},
            testCount: Array.isArray(challenge.tests) ? challenge.tests.length : 0
        }
    });
});

app.post('/api/practice/submit', async (req, res) => {
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    const challengeId = String(req.body?.challengeId || '').trim();
    const language = String(req.body?.language || 'javascript').trim().toLowerCase();
    const code = String(req.body?.code || '');

    if (!normalizedEmail) {
        return res.status(400).json({ success: false, message: 'Login required.' });
    }
    if (!challengeId) {
        return res.status(400).json({ success: false, message: 'Challenge id is required.' });
    }
    if (!code.trim()) {
        return res.status(400).json({ success: false, message: 'Code cannot be empty.' });
    }

    const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (user.accountStatus === 'blocked') {
        return res.status(403).json({ success: false, message: 'Your account is blocked by admin.' });
    }

    const challenge = getPracticeChallengeById(challengeId);
    if (!challenge) {
        return res.status(404).json({ success: false, message: 'Challenge not found.' });
    }

    if (!['javascript', 'python'].includes(language)) {
        return res.status(400).json({ success: false, message: 'Practice Arena supports JavaScript and Python only.' });
    }

    const validation = validateCodeByLanguage(language, code);
    if (!validation.valid) {
        return res.status(400).json({ success: false, message: validation.message });
    }

    const result = await evaluatePracticeChallenge(language, code, challenge);
    const normalizedUser = normalizeUserEnrollment(user);
    normalizedUser.practiceArena.attempts += 1;
    normalizedUser.practiceArena.lastAttemptAt = new Date().toISOString();

    let xpGained = 0;
    if (result.passed) {
        const alreadySolved = normalizedUser.practiceArena.solvedChallengeIds.includes(challenge.id);
        if (!alreadySolved) {
            normalizedUser.practiceArena.solvedChallengeIds.push(challenge.id);
            xpGained = addXp(normalizedUser, Math.max(30, gamificationConfig.rewards.topicXp * 6));
            applyBadges(normalizedUser);
        }
    }

    Object.assign(user, normalizedUser);
    saveData(usersFile, users);

    return res.json({
        success: true,
        passed: Boolean(result.passed),
        passedCount: Number(result.passedCount) || 0,
        total: Number(result.total) || 0,
        failedAt: result.failedAt || null,
        expected: typeof result.expected === 'undefined' ? null : normalizePracticeValue(result.expected, challenge.normalize || ''),
        actual: typeof result.actual === 'undefined' ? null : normalizePracticeValue(result.actual, challenge.normalize || ''),
        error: result.error || '',
        xpGained,
        practiceStats: {
            solvedCount: normalizedUser.practiceArena.solvedChallengeIds.length,
            attempts: normalizedUser.practiceArena.attempts
        },
        user: toClientUser(user)
    });
});

app.get('/api/skill-analyzer/tracks', (req, res) => {
    res.json({
        success: true,
        tracks: getSkillAnalyzerPublicTracks()
    });
});

app.get('/api/skill-analyzer/test', (req, res) => {
    const trackId = String(req.query.track || '').trim().toLowerCase();
    const track = getSkillAnalyzerTrack(trackId);
    if (!track) {
        return res.status(404).json({
            success: false,
            message: 'Track not found'
        });
    }

    const questions = track.questions.map(question => ({
        id: question.id,
        prompt: question.prompt,
        options: question.options
    }));
    return res.json({
        success: true,
        track: {
            id: track.id,
            title: track.title,
            description: track.description
        },
        questions
    });
});

app.post('/api/skill-analyzer/evaluate', (req, res) => {
    const trackId = String(req.body?.track || '').trim().toLowerCase();
    const track = getSkillAnalyzerTrack(trackId);
    if (!track) {
        return res.status(404).json({
            success: false,
            message: 'Track not found'
        });
    }

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (answers.length !== track.questions.length) {
        return res.status(400).json({
            success: false,
            message: 'Please answer all test questions.'
        });
    }

    let totalScore = 0;
    const maxScore = track.questions.length * 3;
    const weakCounter = new Map();

    for (let i = 0; i < track.questions.length; i += 1) {
        const answerIndex = Number(answers[i]);
        const question = track.questions[i];
        if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
            return res.status(400).json({
                success: false,
                message: `Invalid answer for question ${i + 1}`
            });
        }
        totalScore += answerIndex;
        if (answerIndex <= 1 && question.skill) {
            weakCounter.set(question.skill, (weakCounter.get(question.skill) || 0) + (2 - answerIndex));
        }
    }

    const scorePercent = Math.round((totalScore / Math.max(1, maxScore)) * 100);
    const level = getLevelFromScorePercent(scorePercent);
    const roadmap = buildRoadmapByLevel(track, level);
    const weakAreas = [...weakCounter.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([skill]) => track.skillMap[skill] || skill);

    const recommendations = [
        `Follow the ${level} roadmap for ${track.title} with weekly milestones.`,
        weakAreas.length
            ? `Focus first on: ${weakAreas.join(', ')}`
            : 'Strengthen consistency with daily coding and revision.',
        'Build one portfolio project at each stage and review with mentor feedback.'
    ];

    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    if (normalizedEmail) {
        const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
        if (user) {
            user.skillAnalyzer = {
                trackId: track.id,
                trackTitle: track.title,
                level,
                scorePercent,
                weakAreas,
                roadmap,
                recommendations,
                updatedAt: new Date().toISOString()
            };
            saveData(usersFile, users);
        }
    }

    return res.json({
        success: true,
        result: {
            trackId: track.id,
            trackTitle: track.title,
            level,
            scorePercent,
            weakAreas,
            roadmap,
            recommendations
        }
    });
});

app.get('/api/career-paths/goals', (req, res) => {
    return res.json({
        success: true,
        goals: getCareerPathGoals()
    });
});

app.post('/api/career-paths/generate', (req, res) => {
    const goal = String(req.body?.goal || '').trim().toLowerCase();
    const path = getCareerPathByGoal(goal);
    if (!path) {
        return res.status(404).json({
            success: false,
            message: 'Career goal not found.'
        });
    }

    const catalog = getCoursesCatalog();
    const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
    let enrolledSlugs = new Set();

    if (normalizedEmail) {
        const user = users.find(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
        if (user) {
            const normalizedUser = normalizeUserEnrollment(user);
            enrolledSlugs = new Set((normalizedUser.enrolledCourses || []).map(item => item.slug));
        }
    }

    const recommendedCourses = path.recommendedCourses.map(title => {
        const course = catalog.find(item => item.title === title);
        if (!course) {
            return {
                title,
                slug: slugifyCourse(title),
                duration: 'Flexible',
                level: 'Beginner to Advanced',
                enrolled: false
            };
        }
        return {
            title: course.title,
            slug: course.slug,
            duration: course.duration,
            level: course.level,
            enrolled: enrolledSlugs.has(course.slug)
        };
    });

    const roadmap = (path.roadmap || []).map(stage => ({
        ...stage,
        nextAction: `${stage.milestones[0]}`
    }));

    return res.json({
        success: true,
        careerPath: {
            id: path.id,
            title: path.title,
            summary: path.summary,
            roadmap,
            recommendedCourses
        }
    });
});

// Download syllabus as PDF for a course
app.get('/api/courses/:identifier/syllabus.pdf', (req, res) => {
    const { identifier } = req.params;
    const course = getCourseByIdentifier(identifier);
    if (!course) {
        return res.status(404).json({ success: false, message: 'Course not found' });
    }

    const lines = [
        `${course.title} - Full Syllabus`,
        `Duration: ${course.duration}`,
        `Level: ${course.level}`,
        ' ',
        'Topics Covered:'
    ];
    course.topics.forEach((topic, idx) => {
        lines.push(`${idx + 1}. ${topic}`);
    });

    const pdfBuffer = createSimplePdf(lines);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${course.slug}-syllabus.pdf"`);
    return res.send(pdfBuffer);
});

// Get single course by id or slug
app.get('/api/courses/:identifier', (req, res) => {
    const { identifier } = req.params;
    const course = getCourseByIdentifier(identifier);
    if (!course) {
        return res.status(404).json({ success: false, message: 'Course not found' });
    }
    return res.json(course);
});

// Submit contact/inquiry form
app.post('/api/contact', (req, res) => {
    const { name, email, phone, course, message } = req.body;
    
    // Validation
    if (!name || !email || !phone) {
        return res.status(400).json({ 
            success: false, 
            message: 'Name, email, and phone are required' 
        });
    }
    
    const inquiry = {
        id: inquiries.length + 1,
        name,
        email,
        phone,
        course: course || 'General',
        message: message || '',
        status: 'pending',
        date: new Date().toISOString()
    };
    
    inquiries.push(inquiry);
    saveData(inquiriesFile, inquiries);
    
    console.log('New Inquiry Received:', inquiry);
    
    res.json({ 
        success: true, 
        message: 'Thank you for your inquiry! We will contact you soon.',
        inquiryId: inquiry.id
    });
});

// Get all inquiries (for admin)
app.get('/api/inquiries', requireAdminAuth, (req, res) => {
    res.json(inquiries.map(normalizeInquiry));
});

// Update inquiry (for admin)
app.put('/api/inquiries/:id', requireAdminAuth, (req, res) => {
    const inquiryId = Number(req.params.id);
    if (!Number.isInteger(inquiryId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid inquiry id'
        });
    }

    const inquiryIndex = inquiries.findIndex(i => Number(i.id) === inquiryId);
    if (inquiryIndex === -1) {
        return res.status(404).json({
            success: false,
            message: 'Inquiry not found'
        });
    }

    const payload = req.body || {};
    const current = normalizeInquiry(inquiries[inquiryIndex]);
    const nextStatus = payload.status === 'resolved' ? 'resolved' : 'pending';
    const updated = {
        ...current,
        status: nextStatus
    };

    inquiries[inquiryIndex] = updated;
    saveData(inquiriesFile, inquiries);

    return res.json({
        success: true,
        message: 'Inquiry updated successfully',
        inquiry: updated
    });
});

function handleDeleteInquiry(req, res) {
    const inquiryId = Number(req.params.id);
    if (!Number.isInteger(inquiryId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid inquiry id'
        });
    }

    const inquiryIndex = inquiries.findIndex(i => Number(i.id) === inquiryId);
    if (inquiryIndex === -1) {
        return res.status(404).json({
            success: false,
            message: 'Inquiry not found'
        });
    }

    const [removedInquiry] = inquiries.splice(inquiryIndex, 1);
    saveData(inquiriesFile, inquiries);

    return res.json({
        success: true,
        message: 'Inquiry deleted successfully',
        inquiry: normalizeInquiry(removedInquiry)
    });
}

app.delete('/api/inquiries/:id', requireAdminAuth, handleDeleteInquiry);
app.post('/api/inquiries/:id/delete', requireAdminAuth, handleDeleteInquiry);

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/courses', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'courses.html'));
});

app.get('/course-details', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'course-details.html'));
});

app.get('/course/:identifier', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'course-details.html'));
});

app.get('/testimonials', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'testimonials.html'));
});

app.get('/gallery', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('/faculty', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'faculty.html'));
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/payment', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

app.get('/code-lab', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'code-lab.html'));
});

app.get('/skill-analyzer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'skill-analyzer.html'));
});

app.get('/career-path', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'career-path.html'));
});

app.get('/practice-arena', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'practice-arena.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Tejas Computer Institute website running on http://localhost:${PORT}`);
    console.log(`Contact API available at http://localhost:${PORT}/api/contact`);
});
