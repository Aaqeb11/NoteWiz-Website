import dotenv from "dotenv"
import OpenAI from "openai";
import NodeCache from "node-cache";
import { createInterface } from "readline";
import { NextResponse } from "next/server";
import prisma from "@/prisma";


const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
});

dotenv.config({ path: "../../.env" });
const assistantCache = new NodeCache();

const API_KEY = process.env.API_KEY;
function cleanResponseText(text) {
  return text.replace(/【\d+:\d+†.*】/g, "");
}
const assistantHistory = [];

export const POST = async (request) => {

  const data = await request.formData();
  let NewFile = data.get('file');
  console.log(data.get("file"));
  let myAssistant1 = assistantCache.get("myAssistant");
  let userInput = data.get("message");
  let session = JSON.parse(data.get("session"))
  console.log();
  let userId = session.user.id
  let chatbotId = session.user.chatbots[0]?.id;
  console.log(chatbotId)
  console.log(userId)
  assistantHistory.push({ role: "user", content: userInput });
  const secretKey = API_KEY;
  const openai = new OpenAI({
    apiKey: secretKey,
  });
  var file;
  var fileID;

  if (!myAssistant1) {
    myAssistant1 = await openai.beta.assistants.create({
      instructions: "Answer the user prompts regarding the file uploaded by the user as quickly and precisely as possible, don't delay the answer and do not contain the name of the file at the end of the response.",
      name: "Chatbot",
      model: "gpt-4o",
    });
    assistantCache.set("myAssistant", myAssistant1);
  } else {
    console.log("assistant already created");
  }
  console.log("assistant 1", myAssistant1);
  if (NewFile) {
    console.log("inside if block")
    //upload file to openai
    if (!file) {

      file = await openai.files.create({
        file: NewFile,
        purpose: "assistants",
      });
      console.log(file);
      var vectorStore = await openai.beta.vectorStores.create({
        name: "NoteWiz",
      });
      console.log(vectorStore);
      var myVectorStoreFile = await openai.beta.vectorStores.files.create(
        vectorStore.id,
        {
          file_id: file.id,
        }
      );
      console.log(myVectorStoreFile);
      fileID = file.id;

      // Fallback if no file is uploaded, create a generic assistant without file search tools
      myAssistant1 = await openai.beta.assistants.update(myAssistant1.id, {
        instructions: "Answer the user prompts regarding the file uploaded by the user as quickly and precisely as possible, please give the response in form array of bullet points but in detail and do not contain the name of the file at the end of the response.",
        name: "Chatbot",
        tools: [{ type: "file_search" }],
        tool_resources: {
          file_search: {
            vector_store_ids: [vectorStore.id],
          },
        },
        model: "gpt-4o",
      });
      assistantCache.set("myAssistant", myAssistant1);
      // }
    } else {
      console.log("file already uploaded");
    }
  }
  if (userInput) {
    const threadMessages = assistantHistory.map((item) => ({
      role: item.role,
      content: item.content,
      attachments: fileID ? [{ file_id: fileID, tools: [{ type: "file_search" }] }] : [],
    }));
    //create a thread and run
    const stream = await openai.beta.threads.createAndRun({
      assistant_id: myAssistant1.id,
      thread: {
        messages: threadMessages
      },
      stream: true,
    });
    const messages = [];

    for await (const event of stream) {
      if (event.data && event.data.content) {
        // Loop through each content item (assuming each content item follows the shown structure)
        event.data.content.forEach((contentItem) => {
          if (contentItem.text && contentItem.text.value) {
            const cleanedText = cleanResponseText(contentItem.text.value);
            console.log(cleanedText); // Now logging without the source marks
            messages.push(cleanedText);
            messages.forEach((response) => {
              assistantHistory.push({ role: "assistant", content: response });
            });
            console.log(assistantHistory)
          }
        });
      } else {
        console.log("Waiting for more data...");
      }
    }
    
    console.log(assistantHistory)
    try {
      // console.log(userId)
      // console.log(assistantHistory.map((chat) => ({
      //   "role": chat.role,
      //   "chat":chat.content
      // })))
      // const chatbots = await prisma.chatbot.create({
      //   data: {
      //     userId: userId,
      //     topic: "hello",
      //     chats: {
      //       create: assistantHistory.map((chat) => ({
      //         role: chat.role,
      //         content:chat.content
      //       }))
      //     }
      //   }
      // })
      if (!chatbotId) {
        // Create a new Chatbot record if it doesn't exist
        const newChatbot = await prisma.chatbot.create({
          data: {
            userId: userId,
            topic: "Chat Session",
            chats: {
              create: assistantHistory.map((chat) => ({
                role: chat.role,
                content: chat.content,
              }))
            }
          }
        });
        chatbotId = newChatbot.id; // Save the new chatbotId
        session.chatbotId = chatbotId; // Update session with chatbotId
      } else {
        // Add new chats to the existing Chatbot record
        await prisma.chatbot.update({
          where: { id: chatbotId },
          data: {
            chats: {
              create: assistantHistory.map((chat) => ({
                role: chat.role,
                content: chat.content,
              }))
            }
          }
        });
      }
    } catch (error) {
      console.log("error saving chats",error)
      return NextResponse.json({"error":error})
    }
    return NextResponse.json({ messages });

  } else {
    console.log("error entering if block");
    return NextResponse.json({ error: "No user input provided" });
  }
}