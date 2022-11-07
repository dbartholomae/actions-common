import fs from "fs";
import { getOctokit, context } from "@actions/github";
import actionHelper from "./action-helper";
import { Report } from "./models";
import { components } from "@octokit/openapi-types";

const actionCommon = {
  processReport: async (
    token: string,
    workSpace: string,
    plugins: string[],
    currentRunnerID: string,
    issueTitle: string,
    repoName: string,
    allowIssueWriting = true,
    artifactName = "zap_scan"
  ) => {
    const jsonReportName = "report_json.json";
    const mdReportName = "report_md.md";
    const htmlReportName = "report_html.html";

    if (!allowIssueWriting) {
      await actionHelper.uploadArtifacts(
        workSpace,
        mdReportName,
        jsonReportName,
        htmlReportName
      );
      return;
    }

    let openIssue:
      | components["schemas"]["issue-search-result-item"]
      | undefined;
    let currentReport: Report | undefined;
    let previousRunnerID;
    let previousReport: Partial<Report> | undefined = {};
    let create_new_issue = false;

    const tmp = repoName.split("/");
    const owner = tmp[0];
    const repo = tmp[1];

    const octokit = getOctokit(token, {
      baseUrl: process.env.GITHUB_API_URL,
    }).rest;

    try {
      const jReportFile = fs.readFileSync(`${workSpace}/${jsonReportName}`);
      currentReport = JSON.parse(jReportFile.toString()) as Report;
    } catch (e) {
      console.log("Failed to locate the json report generated by ZAP Scan!");
      return;
    }

    const issues = await octokit.search.issuesAndPullRequests({
      q: encodeURI(
        `is:issue state:open repo:${owner}/${repo} ${issueTitle}`
      ).replace(/%20/g, "+"),
      sort: "updated",
    });

    // If there is no existing open issue then create a new issue
    if (issues.data.items.length === 0) {
      create_new_issue = true;
    } else {
      // Sometimes search API returns recently closed issue as an open issue
      for (let i = 0; i < issues.data.items.length; i++) {
        const issue = issues.data.items[i];
        if (
          issue["state"] === "open" &&
          issue["user"]!["login"] === "github-actions[bot]"
        ) {
          openIssue = issue;
          break;
        }
      }

      if (openIssue === undefined) {
        create_new_issue = true;
      } else {
        console.log(
          `Ongoing open issue has been identified #${openIssue["number"]}`
        );
        // If there is no comments then read the body
        if (openIssue["comments"] === 0) {
          previousRunnerID = actionHelper.getRunnerID(openIssue["body"]!);
        } else {
          const comments = await octokit.issues.listComments({
            owner: owner,
            repo: repo,
            issue_number: openIssue["number"],
          });

          let lastBotComment;
          const lastCommentIndex = comments["data"].length - 1;
          for (let i = lastCommentIndex; i >= 0; i--) {
            if (
              comments["data"][i]["user"]!["login"] === "github-actions[bot]"
            ) {
              lastBotComment = comments["data"][i];
              break;
            }
          }

          if (lastBotComment === undefined) {
            previousRunnerID = actionHelper.getRunnerID(openIssue["body"]!);
          } else {
            previousRunnerID = actionHelper.getRunnerID(
              lastBotComment["body"]!
            );
          }
        }

        if (previousRunnerID !== null) {
          previousReport = await actionHelper.readPreviousReport(
            octokit,
            owner,
            repo,
            workSpace,
            previousRunnerID
          );
          if (previousReport === undefined) {
            create_new_issue = true;
          }
        }
      }
    }

    if (plugins.length !== 0) {
      console.log(
        `${plugins.length} plugins will be ignored according to the rules configuration`
      );
      currentReport = await actionHelper.filterReport(currentReport, plugins);

      // Update the newly filtered report
      fs.unlinkSync(`${workSpace}/${jsonReportName}`);
      fs.writeFileSync(
        `${workSpace}/${jsonReportName}`,
        JSON.stringify(currentReport)
      );
      console.log("The current report is updated with the ignored alerts!");
    }

    const newAlertExits = actionHelper.checkIfAlertsExists(currentReport);

    console.log(
      `Alerts present in the current report: ${newAlertExits.toString()}`
    );

    if (!newAlertExits) {
      // If no new alerts have been found close the issue
      console.log("No new alerts have been identified by the ZAP Scan");
      if (openIssue != null && openIssue.state === "open") {
        // close the issue with a comment
        console.log(`Starting to close the issue #${openIssue.number}`);
        try {
          await octokit.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: openIssue.number,
            body: "All the alerts have been resolved during the last ZAP Scan!",
          });
          await octokit.issues.update({
            owner: owner,
            repo: repo,
            issue_number: openIssue.number,
            state: "closed",
          });
          console.log(`Successfully closed the issue #${openIssue.number}`);
        } catch (err) {
          console.log(
            `Error occurred while closing the issue with a comment! err: ${(
              err as Error
            ).toString()}`
          );
        }
      } else if (openIssue != null && openIssue.state === "closed") {
        console.log(
          "No alerts found by ZAP Scan and no active issue is found in the repository, exiting the program!"
        );
      }
      return;
    }

    const runnerInfo = `RunnerID:${currentRunnerID}`;
    const runnerLink =
      `View the [following link](${context.serverUrl}/${owner}/${repo}/actions/runs/${currentRunnerID})` +
      ` to download the report.`;
    if (create_new_issue) {
      const msg = actionHelper.createMessage(
        currentReport["site"],
        runnerInfo,
        runnerLink
      );
      const newIssue = await octokit.issues.create({
        owner: owner,
        repo: repo,
        title: issueTitle,
        body: msg,
      });
      console.log(
        `Process completed successfully and a new issue #${newIssue.data.number} has been created for the ZAP Scan.`
      );
    } else {
      const siteClone = actionHelper.generateDifference(
        currentReport,
        previousReport as Report
      );
      if (currentReport.updated) {
        console.log(
          "The current report has changes compared to the previous report"
        );
        try {
          const msg = actionHelper.createMessage(
            siteClone,
            runnerInfo,
            runnerLink
          );
          await octokit.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: openIssue!["number"],
            body: msg,
          });

          console.log(
            `The issue #${
              openIssue!.number
            } has been updated with the latest ZAP scan results!`
          );
          console.log("ZAP Scan process completed successfully!");
        } catch (err) {
          console.log(
            `Error occurred while updating the issue #${
              openIssue!.number
            } with the latest ZAP scan: ${(err as Error).toString()}`
          );
        }
      } else {
        console.log(
          "No changes have been observed from the previous scan and current scan!, exiting the program!"
        );
      }
    }

    await actionHelper.uploadArtifacts(
      workSpace,
      mdReportName,
      jsonReportName,
      htmlReportName,
      artifactName
    );
  },
};

export const main = actionCommon;
export const helper = actionHelper;
