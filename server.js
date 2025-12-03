const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|bmp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'));
        }
    }
});

// Initialize SQLite database
const db = new sqlite3.Database('dermai.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Images table
    db.run(`CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        filename TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    // Detection results table
    db.run(`CREATE TABLE IF NOT EXISTS detection_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id INTEGER,
        user_id INTEGER,
        disease TEXT NOT NULL,
        accuracy REAL NOT NULL,
        medicine TEXT NOT NULL,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (image_id) REFERENCES images(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    console.log('Database tables initialized.');
}

// API Routes

// User Signup
app.post('/api/signup', async (req, res) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        db.run(
            `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
            [username, email, hashedPassword],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.status(409).json({ error: 'Username or email already exists' });
                    }
                    return res.status(500).json({ error: 'Error creating user' });
                }
                res.json({ 
                    success: true, 
                    message: 'User created successfully',
                    userId: this.lastID 
                });
            }
        );
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// User Signin
app.post('/api/signin', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user by email
    db.get(
        `SELECT * FROM users WHERE email = ?`,
        [email],
        async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Check password
            const isValidPassword = await bcrypt.compare(password, user.password);
            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Return user data (without password)
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        }
    );
});

// Upload image
app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded' });
    }

    const userId = req.body.userId || null; // Optional user ID
    const { originalname } = req.file;

    // Save image info to database
    db.run(
        `INSERT INTO images (user_id, filename, original_filename, file_path) VALUES (?, ?, ?, ?)`,
        [userId, req.file.filename, originalname, req.file.path],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Error saving image' });
            }

            res.json({
                success: true,
                imageId: this.lastID,
                filename: req.file.filename,
                originalFilename: originalname,
                filePath: req.file.path
            });
        }
    );
});

// Save detection result
app.post('/api/detection-result', (req, res) => {
    const { imageId, userId, disease, accuracy, medicine } = req.body;

    if (!disease || !accuracy || !medicine) {
        return res.status(400).json({ error: 'Disease, accuracy, and medicine are required' });
    }

    db.run(
        `INSERT INTO detection_results (image_id, user_id, disease, accuracy, medicine) VALUES (?, ?, ?, ?, ?)`,
        [imageId || null, userId || null, disease, accuracy, medicine],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Error saving detection result' });
            }

            res.json({
                success: true,
                resultId: this.lastID,
                disease,
                accuracy,
                medicine
            });
        }
    );
});

// Get user's detection history
app.get('/api/history/:userId', (req, res) => {
    const userId = req.params.userId;

    db.all(
        `SELECT dr.*, i.original_filename, i.uploaded_at 
         FROM detection_results dr
         LEFT JOIN images i ON dr.image_id = i.id
         WHERE dr.user_id = ?
         ORDER BY dr.detected_at DESC`,
        [userId],
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: 'Error fetching history' });
            }
            res.json({ success: true, history: results });
        }
    );
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'DERMAI Backend is running' });
});

// Start server
app.listen(PORT, () => {
    console.log(`DERMAI Backend server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed.');
        process.exit(0);
    });
});

