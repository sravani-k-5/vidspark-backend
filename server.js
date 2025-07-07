const express = require("express");
require("dotenv").config()
const app = express();
const multer = require("multer");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
app.use(cors());
app.use(express.json());
const SECRET_KEY = process.env.JWT_SECRET_KEY;
mongoose
.connect(process.env.MOGOOURI)
  .then(() => console.log("DB connected"))
  .catch((err) => console.log(err));
const videoSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  path: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  vidtitle: { type: String, required: true },
  vidcategory: { type: String, required: true },
  viddescription: { type: String, required: true },
});
const Video = mongoose.model("sharing", videoSchema);
const userSchema = new mongoose.Schema({
  user: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  tokens: [{ token: String }],
  likedVideos: [{ type: mongoose.Schema.Types.ObjectId, ref: "sharing" }],
  sharedVideos:[{ type: mongoose.Schema.Types.ObjectId, ref: "sharing" }],
});
const Usermodel = mongoose.model("users", userSchema);
const s3ClientConfig = new S3Client({
    region: "ap-south-1",
    credentials: {
      accessKeyId: process.env.awsAccessKey,
      secretAccessKey: process.env.awsSecretKey,
    },
  });
  const BUCKET_NAME = process.env.awsBucketName;
const upload = multer({ storage: multer.memoryStorage() });


// Comment Schema
const commentSchema = new mongoose.Schema({
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: "sharing", required: true }, // Changed from "videos" to "sharing"
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "users", required: true },
  text: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now },
});

const Comment = mongoose.model("comment", commentSchema);



// post videos
app.post("/videoUpload", upload.single("source"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ status: "failed", message: "No file uploaded" });
  }
  try {
    const fileName = Date.now() + "-" + file.originalname;
    await s3ClientConfig.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );
    const newVideo = new Video({
      title: file.originalname,
      path: fileName,
      vidtitle: req.body.title,
      viddescription: req.body.description,
      vidcategory: req.body.category,
    });
    await newVideo.save();
    return res.status(200).json({
      status: "success",
      message: "Video uploaded successfully",
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ status: "failed", message: "Error uploading video" });
  }
});
const getObjectURL = async (s3key) => {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3key });
  return await getSignedUrl(s3ClientConfig, command);
};
// get videos
app.get("/videos", async (req, res) => {
  try {
    const vidcategory = req.query.vidcategory;

    let videos;
    if (vidcategory) {
      const data = await Video.find({ vidcategory });
      videos = await Promise.all(
        data.map(async (val) => {
          return { ...val.toObject(), url: await getObjectURL(val.path) };
        }))
    } else {
      const data = await Video.find();

      videos = await Promise.all(
        data.map(async (val) => {
          return { ...val.toObject(), url: await getObjectURL(val.path) };
        })
      );
    }

    return res.json(videos);
  } catch (error) {
    console.error("Error fetching videos:", error);
    res.status(500).json({ message: "Error fetching videos" });
  }
});

  // signup page
app.post("/signup", async (req, res) => {
  const { user, email, password } = req.body;
  try {
      const existingUser = await Usermodel.findOne({ email });
      if (existingUser) {
          return res.status(400).json({ message: "User already exists!" });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = new Usermodel({ user, email, password: hashedPassword });
      await newUser.save();
      res.status(201).json({ message: "User registered successfully!", user: newUser });
  } catch (error) {
      console.error("Signup Error:", error); 
      res.status(500).json({ message: "Server error", error });
  }
});
// login page
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
      const user = await Usermodel.findOne({ email });
      if (!user) {
          return res.status(401).json({ message: "Invalid email or password!" });
      }
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
          return res.status(401).json({ message: "Invalid email or password!" });
      }
      const token = jwt.sign({ userId: user._id, email: user.email }, SECRET_KEY, { expiresIn: "72h" });
      if (!user.tokens) user.tokens = [];
      user.tokens.push({ token });
      await user.save();
      res.status(200).json({ 
          message: "Login successful!", 
          token, 
          user: { name: user.name, email: user.email } 
      });
  } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ message: "Server error", error });
  }
});
// post likedvideos
app.post("/api/likeVideo/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }
  try {
    const decoded = jwt.verify(token,SECRET_KEY);
    console.log("Decoded Token:", decoded); 
    const userId = decoded.userId; 
    if (!userId) {
      return res.status(400).json({ message: "Invalid token: No user ID found" });
    }
    const user = await Usermodel.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    console.log("User found:", user);
    const videoIndex = user.likedVideos.findIndex((id) => id.toString() === videoId);
    if (videoIndex !== -1) {
      user.likedVideos.splice(videoIndex, 1); 
    } else {
      user.likedVideos.push(videoId);
    }
    await user.save();
    console.log("Updated likedVideos:", user.likedVideos);
    res.json({ likedVideos: user.likedVideos, message: "Action successful" });
  } catch (error) {
    console.error("Error verifying token:", error);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});
// get likedvideos 
app.get("/api/likedVideos", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }
  try {
    const decoded = jwt.verify(token,SECRET_KEY );
    const userId = decoded.userId;
    console.log(decoded)
    if (!userId) {
      return res.status(400).json({ message: "Invalid token: No user ID found" });
    }
    const user = await Usermodel.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.likedVideos || user.likedVideos.length === 0) {
      return res.json({ likedVideos: [] });
    }
    const data = await Video.find({ _id: { $in: user.likedVideos } });
    const likedVideos = await Promise.all(
      data.map(async (val) => {
        return { ...val.toObject(), url: await getObjectURL(val.path) };
      })
    );
    res.json({ likedVideos });
  } catch (error) {
    console.error("Error fetching liked videos:", error);
    res.status(500).json({ message: "Error fetching liked videos", error: error.message });
  }
});
// post shared videos
app.post("/api/shareVideo/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }
  try {
    const decoded = jwt.verify(token,SECRET_KEY);
    console.log("Decoded Token:", decoded); 
    const userId = decoded.userId; 
    if (!userId) {
      return res.status(400).json({ message: "Invalid token: No user ID found" });
    }
    const user = await Usermodel.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    console.log("User found:", user);
    const videoIndex = user.sharedVideos.findIndex((id) => id.toString() === videoId);
    if (videoIndex !== -1) {
      user.sharedVideos.splice(videoIndex, 1); 
    } else {
      user.sharedVideos.push(videoId);
    }
    await user.save();
    res.json({ likedVideos: user.likedVideos, message: "Action successful" });
  } catch (error) {
    console.error("Error verifying token:", error);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
});
// get shared videos
app.get("/api/sharedVideos", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }
  try {
    const decoded = jwt.verify(token,SECRET_KEY );
    const userId = decoded.userId;
    console.log(decoded)
    if (!userId) {
      return res.status(400).json({ message: "Invalid token: No user ID found" });
    }
    const user = await Usermodel.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.sharedVideos || user.sharedVideos.length === 0) {
      return res.json({ sharedVideos: [] });
    }
    const sharedVideos = await Video.find({ _id: { $in: user.sharedVideos } });
    res.json({ sharedVideos });
  } catch (error) {
    res.status(500).json({ message: "Error fetching liked videos", error: error.message });
  }
});

// post comments
app.post("/api/comments", async (req, res) => {
  const { videoId, text } = req.body;
  const token = req.headers.authorization?.split(" ")[1];

  console.log("🔹 Incoming Request:", { videoId, text, token });

  if (!token) return res.status(401).json({ message: "Unauthorized: No token provided" });

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    console.log("🔹 Decoded Token:", decoded);

    const userId = decoded.userId;
    if (!userId) return res.status(400).json({ message: "Invalid token: No user ID found" });

    const newComment = new Comment({ videoId, userId, text });
    await newComment.save();

    console.log("✅ Comment Saved:", newComment);
    res.status(201).json({ message: "Comment posted successfully!", comment: newComment });
  } catch (error) {
    console.error("❌ Error Posting Comment:", error);
    res.status(500).json({ message: "Server error", error });
  }
});
// delete comments
app.delete("/api/comments/:id", async (req, res) => {
  const commentId = req.params.id;
  const token = req.headers.authorization?.split(" ")[1];

  console.log("🔹 Delete Request for Comment ID:", commentId, "with Token:", token);

  if (!token) return res.status(401).json({ message: "Unauthorized: No token provided" });

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    console.log("🔹 Decoded Token:", decoded);

    const userId = decoded.userId;
    if (!userId) return res.status(400).json({ message: "Invalid token: No user ID found" });

    // Find the comment
    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    // Check if the logged-in user is the owner of the comment
    if (comment.userId.toString() !== userId) {
      return res.status(403).json({ message: "Forbidden: You can only delete your own comments" });
    }

    // Delete the comment
    await Comment.findByIdAndDelete(commentId);
    console.log("✅ Comment Deleted:", commentId);

    res.status(200).json({ message: "Comment deleted successfully!" });
  } catch (error) {
    console.error("❌ Error Deleting Comment:", error);
    res.status(500).json({ message: "Server error", error });
  }
});


// fetch Comments
app.get("/api/comments/:videoId", async (req, res) => {
  const { videoId } = req.params;

  try {
    const comments = await Comment.find({ videoId }).populate("userId", "user"); // Populating username
    res.json(comments);
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ message: "Error fetching comments" });
  }
});




app.listen(3002, () => console.log("Server is running on port 3002"));


