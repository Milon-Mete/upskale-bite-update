/**
 * 🔄 MIGRATION SCRIPT: Legacy videoUrl → videoUrls.bn
 * 
 * Run this ONCE to migrate any old documents that have `videoUrl`
 * but are missing `videoUrls.bn`. After all documents are migrated,
 * the legacy `videoUrl` field can safely be removed from the schema.
 * 
 * Usage: node scripts/migrate-videoUrl.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const BiteSizeCourse = require('../models/BiteSizeCourse');

async function migrate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Find courses where at least one content item has videoUrl but no videoUrls.bn
        const courses = await BiteSizeCourse.find({
            'content.videoUrl': { $exists: true, $ne: '' },
            'content.videoUrls.bn': { $exists: false }
        }).lean();

        console.log(`📦 Found ${courses.length} course(s) with legacy videoUrl data\n`);

        let totalMigrated = 0;

        for (const course of courses) {
            let courseModified = false;

            for (let i = 0; i < course.content.length; i++) {
                const item = course.content[i];
                
                if (item.videoUrl && (!item.videoUrls || !item.videoUrls.bn)) {
                    // Copy videoUrl → videoUrls.bn
                    const setPath = `content.${i}.videoUrls.bn`;
                    await BiteSizeCourse.updateOne(
                        { _id: course._id },
                        { $set: { [setPath]: item.videoUrl } }
                    );
                    console.log(`  ✅ Migrated: "${course.title}" → content[${i}].videoUrls.bn = "${item.videoUrl.substring(0, 50)}..."`);
                    totalMigrated++;
                    courseModified = true;
                }
            }

            if (courseModified) {
                console.log(`  📝 Updated course: "${course.title}" (${course._id})\n`);
            }
        }

        console.log(`\n✅ Migration complete! Migrated ${totalMigrated} video entries.`);
        console.log('   The legacy `videoUrl` field can now be safely removed from the schema.\n');

        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
}

migrate();
