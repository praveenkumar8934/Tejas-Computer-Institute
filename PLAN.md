# Tejas Computer Institute Website - Project Plan

## 1. Project Overview
- **Project Name**: Tejas Computer Institute Website
- **Type**: Multi-page Full-stack Web Application
- **Core Functionality**: A professional computer training institute website with course information, student testimonials, gallery, faculty profiles, and contact functionality
- **Target Users**: Students seeking computer education, parents, and professionals looking to upskill

## 2. Technology Stack
- **Backend**: Node.js with Express.js
- **Frontend**: HTML5, CSS3, JavaScript
- **Database**: In-memory (can be upgraded to MongoDB/SQL)
- **Images**: Unsplash (free image service)

## 3. Website Structure (Multi-page)
1. **index.html** - Homepage
2. **about.html** - About Us
3. **courses.html** - Courses Offered
4. **testimonials.html** - Student Testimonials
5. **gallery.html** - Photo Gallery
6. **faculty.html** - Faculty/Team
7. **contact.html** - Contact Page

## 4. Design Specification
- **Color Theme**: Blue (#0066cc, #004499) and White (#ffffff, #f5f9ff)
- **Typography**: Modern sans-serif (Poppins, Roboto)
- **Responsive**: Mobile, tablet, desktop breakpoints
- **Animations**: Smooth transitions, hover effects, scroll animations

## 5. Backend API Endpoints
- `POST /api/contact` - Handle inquiry form submissions
- `GET /api/courses` - Get courses data (for dynamic content)

## 6. Contact Information
- Address: Dhanaha urf Malludih PO, Karmaini Preamwaliya, Kasia, Kushinagar
- Phone: 8934039262
- Email: pk5952424@gmail.com

## 7. Files to Create
```
/web_development/
├── server.js              (Express backend)
├── package.json           (Node dependencies)
├── public/
│   ├── index.html
│   ├── about.html
│   ├── courses.html
│   ├── testimonials.html
│   ├── gallery.html
│   ├── faculty.html
│   ├── contact.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── main.js
└── PLAN.md
```

## 8. Implementation Steps
1. Create package.json and server.js
2. Create shared CSS with blue-white theme
3. Create index.html (Homepage with hero, courses highlights, stats)
4. Create about.html (Mission, vision, why choose us)
5. Create courses.html (All courses with details)
6. Create testimonials.html (Student reviews)
7. Create gallery.html (Photos grid)
8. Create faculty.html (Trainer profiles)
9. Create contact.html (Form, map, contact info)
10. Create main.js for interactions and API calls
11. Test and deploy
