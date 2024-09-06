const simpleGit = require("simple-git");
const fs = require("fs");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

function localizeDate(date, options, locale) {
  if (!date) return "";
  const defaultLocale =
    locale ??
    (typeof window !== "undefined"
      ? window.navigator.language
      : Intl.DateTimeFormat().resolvedOptions().locale) ??
    "en-US";
  const inputDate =
    date instanceof Date ? date : getDateFromNumberOrString(date);
  const localized = Intl.DateTimeFormat(defaultLocale, options).format(
    inputDate
  );
  return localized;
}

const targetDate = process.env.TARGET_DATE
  ? new Date(process.env.TARGET_DATE)
  : new Date();
const [targetDatesMonth, targetDatesYear] = [
  targetDate.getMonth(),
  targetDate.getFullYear()
];

const projectConfigPath = path.join(__dirname, "config", "projects.json");
let projects;
try {
  projects = JSON.parse(fs.readFileSync(projectConfigPath, "utf8"));
} catch (err) {
  console.error(`Failed to load project configuration: ${err.message}`);
  process.exit(1);
}
// Configuration
const Config = {
  name: () => process.env.AUTHOR ?? "Luis Casillas",
  projects,
  output: () =>
    `data/${targetDatesYear}_${
      targetDatesMonth + 1
    }_${Config.name()}_timesheet.csv`,
  author: process.env.GIT_AUTHORNAMES.split(",") ?? [
    "Luis Casillas",
    "gwitchr",
    "Gwitchr"
  ],
  githubUsername: process.env.GH_USERNAME ?? "Gwitchr",
  githubToken: process.env.GH_TOKEN,
  reviewComment: `Analyzed Pull Request and added comments`,
  commitComment: `Worked on project and PBI associated`,
  totalHours: 160, // Target total hours
  allowedVariation: 5 // Variation of +/- 5 hours
};

// Initialize git clients for each project
const gitClients = Config.projects.map((project) => ({
  name: project.name,
  git: simpleGit(project.path)
}));

// Helper function to filter commits within a specific month
function isCommitInMonth(commitDate) {
  const startOfMonth = new Date(targetDatesYear, targetDatesMonth, 1);
  const endOfMonth = new Date(targetDatesYear, targetDatesMonth + 1, 0);
  return commitDate >= startOfMonth && commitDate <= endOfMonth;
}

// Function to get commits for a project within the specified month
async function getCommits(projectName, gitClient) {
  console.log(`Fetching commits for project: ${projectName}`);
  try {
    const log = await gitClient.log();
    const commits = log.all.filter((commit) => {
      const commitDate = new Date(commit.date);
      // console.log(commitDate,commit.message)
      return isCommitInMonth(commitDate);
    });

    console.log(`Found ${commits.length} commits for project: ${projectName}`);
    return commits.map((commit) => ({
      project: projectName,
      rawDate: new Date(commit.date),
      date: localizeDate(
        new Date(commit.date),
        { month: "long", day: "numeric", year: "numeric" },
        "en-US"
      ),
      message: commit.message,
      author: commit.author_name
    }));
  } catch (error) {
    console.error(`Error fetching commits for project ${projectName}:`, error);
    return [];
  }
}

// Function to search for all pull requests where the user is associated
async function searchPullRequestsAssociatedWithUser() {
  const searchQuery = `type:pr reviewed-by:${Config.githubUsername} is:open`;

  const response = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}`,
    {
      headers: {
        Authorization: `token ${Config.githubToken}`,
        "User-Agent": Config.githubUsername
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to search pull requests: ${response.statusText}`);
  }

  const result = await response.json();
  return result.items.map((pr) => ({
    repo: pr.repository_url.split("/").slice(-2).join("/"),
    number: pr.number,
    title: pr.title
  }));
}

// Function to get pull request reviews from the user
async function getGithubReviews() {
  const reviews = [];

  try {
    // Get all associated pull requests for the user
    const associatedPRs = await searchPullRequestsAssociatedWithUser();

    for (const pr of associatedPRs) {
      const reviewsResponse = await fetch(
        `https://api.github.com/repos/${pr.repo}/pulls/${pr.number}/reviews`,
        {
          headers: {
            Authorization: `token ${Config.githubToken}`,
            "User-Agent": Config.githubUsername
          }
        }
      );
      const prReviews = await reviewsResponse.json();

      prReviews.forEach((review) => {
        const reviewDate = new Date(review.submitted_at);
        if (
          review.user.login === Config.githubUsername &&
          isCommitInMonth(reviewDate)
        ) {
          reviews.push({
            repo: pr.repo,
            rawDate: reviewDate,
            date: localizeDate(
              reviewDate,
              { month: "long", day: "numeric", year: "numeric" },
              "en-US"
            ),
            pullRequest: pr.title,
            reviewComment: review.body || "No comment"
          });
        }
      });
    }
  } catch (error) {
    console.error(`Error fetching reviews: ${error.message}`);
  }

  return reviews;
}

// Helper function to distribute time across entries
function distributeTimeEvenly(numEntries, totalHours, variation) {
  const targetHours = totalHours + (Math.random() * variation * 2 - variation); // Add some variation
  const baseTime = targetHours / numEntries;
  const timeArray = Array.from(
    { length: numEntries },
    () => baseTime + (Math.random() * 2 - 0.5)
  ); // Small random variation for each entry
  const sum = timeArray.reduce((a, b) => a + b, 0);

  // Adjust the times to ensure they sum exactly to targetHours
  const adjustmentFactor = targetHours / sum;
  return timeArray.map((time) => (time * adjustmentFactor).toFixed(2));
}

// Function to write commits to CSV
function writeToCSV(commits, reviews) {
  const totalEntries = commits.length + reviews.length;
  const durations = distributeTimeEvenly(
    totalEntries,
    Config.totalHours,
    Config.allowedVariation
  );
  const csvHeader =
    "Project/Repo,Date,Commit/Review Message,Comments,Time used\n";
  const commitRows = commits.map((commit, i) => ({
    data: `${commit.project},"${commit.date}","${commit.message}",${
      Config.commitComment
    },${durations.at(-i)}`,
    date: commit.rawDate
  }));

  const reviewRows = reviews.map((review, i) => ({
    data: `${review.repo},"${review.date}","${review.pullRequest}","${
      Config.reviewComment
    }",${durations.at(i)}`,
    date: review.rawDate
  }));

  const allRows = [...reviewRows, ...commitRows].sort(
    (a, b) => a.date - b.date
  );

  const allRowsData = allRows.map((row) => row.data).join("\n");

  const csvContent = csvHeader + allRowsData;

  fs.writeFileSync(Config.output(), csvContent);
  console.log(`Timesheet saved to ${Config.output()}`);
}

// Main function to gather commits and write timesheet
(async function fillTimesheet() {
  let allCommits = [];
  let allReviews = [];

  for (const { name, git } of gitClients) {
    const commits = await getCommits(name, git, Config.month);
    const userCommits = commits.filter((commit) =>
      Config.author.includes(commit.author)
    );
    allCommits = allCommits.concat(userCommits);
  }

  // Get reviews from GitHub
  allReviews = await getGithubReviews(Config.month);

  writeToCSV(allCommits, allReviews);
})();
