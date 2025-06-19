const { Client, Databases, Query, Storage, ID } = require('node-appwrite');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Appwrite client
const client = new Client();
const endpoint = process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1';

client
  .setEndpoint(endpoint)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
  .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

const databases = new Databases(client);
const storage = new Storage(client);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuration
const config = {
  databaseId: 'career4me',
  jobsCollectionId: 'jobs',
  talentsCollectionId: 'talents',
  employersCollectionId: '67d870d800046e4c2a61',
  storageId: 'avatars',
  allowedExtensions: ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.txt'],
  maxFileSize: 5 * 1024 * 1024, // 5MB
  aiConfig: {
    model: "gemini-1.5-flash",
    maxOutputTokens: 3000,
    temperature: 0.4
  }
};

/**
 * Utility Functions
 */
const utils = {
  /**
   * Extract and clean JSON from AI response
   */
  extractAndCleanJSON(text) {
    try {
      let cleaned = text
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      
      const startIndex = cleaned.indexOf('{');
      const lastIndex = cleaned.lastIndexOf('}');
      
      if (startIndex === -1 || lastIndex === -1 || startIndex >= lastIndex) {
        throw new Error('No valid JSON object found in response');
      }
      
      cleaned = cleaned
        .substring(startIndex, lastIndex + 1)
        .replace(/,(\s*[}\]])/g, '$1')
        .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      return cleaned;
    } catch (error) {
      throw new Error(`Failed to clean JSON: ${error.message}`);
    }
  },

  /**
   * Validate file type and size
   */
  validateFile(fileName, fileData) {
    const fileExtension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    
    if (!config.allowedExtensions.includes(fileExtension)) {
      throw new Error('Unsupported file type. Please upload PDF, DOC, DOCX, JPG, PNG, or TXT files.');
    }

    const fileSizeBytes = (fileData.length * 3) / 4;
    if (fileSizeBytes > config.maxFileSize) {
      throw new Error('File size too large. Please upload files smaller than 5MB.');
    }

    return { extension: fileExtension, size: fileSizeBytes };
  },

  /**
   * Get MIME type from file extension
   */
  getMimeType(extension) {
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain'
    };
    return mimeTypes[extension] || 'application/octet-stream';
  },

  /**
   * Validate and normalize scores
   */
  normalizeScore(score) {
    return Math.max(0, Math.min(100, score || 0));
  },

  /**
   * Get career stage context for analysis
   */
  getCareerStageContext(careerStage) {
    const stageContexts = {
      'Pathfinder': {
        description: 'Early career professional finding their career direction',
        focus: 'Learning, exploration, and skill building',
        expectations: 'Entry to junior level positions with growth potential',
        priorities: ['Skill development', 'Career exploration', 'Mentorship opportunities']
      },
      'Trailblazer': {
        description: 'Established professional seeking continued growth',
        focus: 'Career advancement and expertise development',
        expectations: 'Mid to senior level positions with leadership opportunities',
        priorities: ['Career progression', 'Leadership development', 'Expertise building']
      },
      'Horizon Changer': {
        description: 'Experienced professional pivoting to new career direction',
        focus: 'Career transition and skill transfer',
        expectations: 'Roles that leverage transferable skills while enabling transition',
        priorities: ['Skill transferability', 'Industry transition', 'Strategic career moves']
      }
    };
    
    return stageContexts[careerStage] || stageContexts['Pathfinder'];
  }
};

/**
 * Document Processing Functions
 */
const documentProcessor = {
  /**
   * Extract text content from document using Gemini Vision
   */
  async extractText(fileBuffer, fileName, documentType = 'CV') {
    try {
      const model = genAI.getGenerativeModel(config.aiConfig);
      const base64Data = fileBuffer.toString('base64');
      const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
      const mimeType = utils.getMimeType(extension);

      const prompts = {
        CV: `Extract all text content from this CV/Resume document. Focus on:
- Personal information and contact details
- Education background and qualifications
- Work experience and employment history
- Technical and soft skills
- Certifications and achievements
- Projects and accomplishments

Return only the extracted text content in a clear, structured format.`,
        
        'Cover Letter': `Extract all text content from this cover letter document. Focus on:
- Contact information and addressing
- Opening and introduction
- Key qualifications and experiences mentioned
- Specific achievements and examples
- Closing statements and call to action

Return only the extracted text content maintaining the document's flow.`
      };

      const result = await model.generateContent([
        prompts[documentType] || prompts.CV,
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        }
      ]);

      const extractedText = result.response.text();
      
      if (!extractedText || extractedText.trim().length < 50) {
        throw new Error(`Insufficient text extracted from ${documentType.toLowerCase()}`);
      }

      return extractedText;
      
    } catch (error) {
      console.error(`${documentType} text extraction error:`, error);
      throw new Error(`Failed to extract text from ${documentType.toLowerCase()}: ${error.message}`);
    }
  }
};

/**
 * Data Fetching Functions
 */
const dataFetcher = {
  /**
   * Fetch talent information by ID
   */
  async getTalent(talentId) {
    try {
      const talentQuery = await databases.listDocuments(
        config.databaseId,
        config.talentsCollectionId,
        [Query.equal('talentId', talentId)]
      );

      if (talentQuery.documents.length === 0) {
        throw new Error('Talent profile not found');
      }

      return talentQuery.documents[0];
    } catch (error) {
      throw new Error(`Failed to fetch talent information: ${error.message}`);
    }
  },

  /**
   * Fetch job information by ID
   */
  async getJob(jobId) {
    try {
      const job = await databases.getDocument(
        config.databaseId,
        config.jobsCollectionId,
        jobId
      );

      return job;
    } catch (error) {
      throw new Error(`Failed to fetch job information: ${error.message}`);
    }
  },

  /**
   * Fetch employer information by ID
   */
  async getEmployer(employerId) {
    try {
      const employer = await databases.getDocument(
        config.databaseId,
        config.employersCollectionId,
        employerId
      );

      return employer;
    } catch (error) {
      console.warn(`Could not fetch employer information: ${error.message}`);
      return null;
    }
  }
};

/**
 * AI Analysis Functions
 */
const aiAnalyzer = {
  /**
   * Analyze CV against specific job requirements with career stage consideration
   */
  async analyzeCVForJob(cvText, talent, job, employer) {
    try {
      const model = genAI.getGenerativeModel(config.aiConfig);
      const careerStageContext = utils.getCareerStageContext(talent.careerStage);

      const prompt = `Analyze this CV against the job requirements considering the candidate's career stage context.

CV CONTENT:
${cvText}

TALENT PROFILE:
- Name: ${talent.fullname}
- Career Stage: ${talent.careerStage} (${careerStageContext.description})
- Career Focus: ${careerStageContext.focus}
- Profile Skills: ${(talent.skills || []).join(', ') || 'None listed'}
- Education: ${(talent.degrees || []).join(', ') || 'None listed'}

JOB REQUIREMENTS:
- Position: ${job.name}
- Company: ${employer?.name || 'Company name not available'}
- Seniority Level: ${job.seniorityLevel}
- Required Skills: ${(job.skills || []).join(', ') || 'Not specified'}
- Required Degrees: ${(job.Degrees || []).join(', ') || 'Not specified'}
- Key Responsibilities: ${job.responsibilities || 'Not detailed'}

CAREER STAGE PRIORITIES: ${careerStageContext.priorities.join(', ')}

Provide analysis in this JSON format with concise, actionable insights:

{
  "overallMatchScore": 75,
  "careerStageAlignment": {
    "score": 80,
    "isAppropriateLevel": true,
    "stageSpecificInsights": "Strong alignment for ${talent.careerStage} stage professional",
    "growthOpportunity": "Role offers good advancement potential"
  },
  "skillsAnalysis": {
    "matchingSkills": ["JavaScript", "React"],
    "criticalGaps": ["Docker", "AWS"],
    "transferableSkills": ["Problem Solving"],
    "matchPercentage": 70
  },
  "experienceAlignment": {
    "relevantExperience": "2+ years relevant experience in web development",
    "levelMatch": true,
    "industryFit": "Good technical foundation for role requirements"
  },
  "educationMatch": {
    "degreeAlignment": 85,
    "additionalCertifications": ["AWS Developer Associate"]
  },
  "topStrengths": [
    "Strong technical foundation matching role requirements",
    "Education background aligns well with position needs",
    "Career stage appropriate for role level and growth path"
  ],
  "improvementAreas": [
    "Obtain AWS certification to strengthen cloud skills",
    "Gain hands-on Docker experience",
    "Build portfolio projects demonstrating industry knowledge"
  ],
  "careerStageGuidance": {
    "recommendation": "Apply with confidence - role aligns with career stage",
    "nextSteps": [
      "Highlight transferable skills in application",
      "Emphasize learning mindset and growth potential",
      "Connect with professionals in target company"
    ],
    "timelineAdvice": "Ready to apply now while pursuing skill development"
  },
  "applicationReadiness": 78
}

Keep insights concise and focused on actionable guidance for this ${talent.careerStage} stage professional.`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      const cleanedJson = utils.extractAndCleanJSON(responseText);
      const analysis = JSON.parse(cleanedJson);
      
      // Normalize scores
      if (analysis.overallMatchScore) analysis.overallMatchScore = utils.normalizeScore(analysis.overallMatchScore);
      if (analysis.careerStageAlignment?.score) analysis.careerStageAlignment.score = utils.normalizeScore(analysis.careerStageAlignment.score);
      if (analysis.skillsAnalysis?.matchPercentage) analysis.skillsAnalysis.matchPercentage = utils.normalizeScore(analysis.skillsAnalysis.matchPercentage);
      if (analysis.educationMatch?.degreeAlignment) analysis.educationMatch.degreeAlignment = utils.normalizeScore(analysis.educationMatch.degreeAlignment);
      if (analysis.applicationReadiness) analysis.applicationReadiness = utils.normalizeScore(analysis.applicationReadiness);
      
      return analysis;
      
    } catch (error) {
      console.error('CV analysis error:', error);
      throw new Error(`Failed to analyze CV: ${error.message}`);
    }
  },

  /**
   * Analyze cover letter against specific job requirements with career stage consideration
   */
  async analyzeCoverLetterForJob(coverLetterText, talent, job, employer) {
    try {
      const model = genAI.getGenerativeModel(config.aiConfig);
      const careerStageContext = utils.getCareerStageContext(talent.careerStage);

      const prompt = `Analyze this cover letter against job requirements considering the candidate's career stage.

COVER LETTER CONTENT:
${coverLetterText}

TALENT PROFILE:
- Name: ${talent.fullname}
- Career Stage: ${talent.careerStage} (${careerStageContext.description})

JOB DETAILS:
- Position: ${job.name}
- Company: ${employer?.name || 'Company name not available'}
- Required Skills: ${(job.skills || []).join(', ') || 'Not specified'}

CAREER STAGE CONTEXT: ${careerStageContext.focus}

Analyze and provide feedback in this JSON format:

{
  "overallEffectiveness": 75,
  "careerStageAppropriate": {
    "score": 80,
    "toneAlignment": "Professional tone appropriate for ${talent.careerStage} stage",
    "contentLevel": "Content demonstrates suitable experience level",
    "growthMindset": "Shows learning orientation suitable for career stage"
  },
  "contentQuality": {
    "jobAlignment": 75,
    "skillsHighlighted": ["JavaScript", "Team Collaboration"],
    "companyResearch": 65,
    "personalizedElements": ["Mentioned company values", "Referenced specific role requirements"]
  },
  "communicationEffectiveness": {
    "clarity": 85,
    "persuasiveness": 70,
    "professionalTone": 90
  },
  "keyStrengths": [
    "Clear articulation of relevant skills and experience",
    "Good understanding of role requirements",
    "Appropriate tone for career stage and industry"
  ],
  "improvements": [
    "Include more specific examples of achievements",
    "Better research into company recent developments",
    "Strengthen closing with clear call to action"
  ],
  "careerStageGuidance": {
    "approach": "Emphasize growth potential and learning mindset",
    "focusAreas": [
      "Highlight relevant coursework and projects",
      "Show enthusiasm for career development",
      "Connect experience to role requirements"
    ]
  },
  "actionItems": [
    "Add specific metrics to achievement examples",
    "Research one recent company achievement to mention",
    "Strengthen closing paragraph with next steps"
  ]
}

Provide specific, actionable feedback for this ${talent.careerStage} professional.`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      const cleanedJson = utils.extractAndCleanJSON(responseText);
      const analysis = JSON.parse(cleanedJson);
      
      // Normalize scores
      if (analysis.overallEffectiveness) analysis.overallEffectiveness = utils.normalizeScore(analysis.overallEffectiveness);
      if (analysis.careerStageAppropriate?.score) analysis.careerStageAppropriate.score = utils.normalizeScore(analysis.careerStageAppropriate.score);
      if (analysis.contentQuality?.jobAlignment) analysis.contentQuality.jobAlignment = utils.normalizeScore(analysis.contentQuality.jobAlignment);
      if (analysis.contentQuality?.companyResearch) analysis.contentQuality.companyResearch = utils.normalizeScore(analysis.contentQuality.companyResearch);
      if (analysis.communicationEffectiveness?.clarity) analysis.communicationEffectiveness.clarity = utils.normalizeScore(analysis.communicationEffectiveness.clarity);
      if (analysis.communicationEffectiveness?.persuasiveness) analysis.communicationEffectiveness.persuasiveness = utils.normalizeScore(analysis.communicationEffectiveness.persuasiveness);
      if (analysis.communicationEffectiveness?.professionalTone) analysis.communicationEffectiveness.professionalTone = utils.normalizeScore(analysis.communicationEffectiveness.professionalTone);

      return analysis;
      
    } catch (error) {
      console.error('Cover letter analysis error:', error);
      throw new Error(`Failed to analyze cover letter: ${error.message}`);
    }
  }
};

/**
 * Main Function Handler
 */
module.exports = async function({ req, res, log, error }) {
  const startTime = Date.now();
  let uploadedFileIds = [];
  
  try {
    log('=== Career-Stage Aware Document Analysis Started ===');
    
    // Validate environment variables
    if (!process.env.GEMINI_API_KEY) {
      error('GEMINI_API_KEY environment variable is required');
      return res.json({ 
        success: false, 
        error: 'Server configuration error', 
        statusCode: 500 
      }, 500);
    }

    // Parse request body
    let requestData;
    try {
      requestData = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      error('Failed to parse request body:', parseError);
      return res.json({ 
        success: false, 
        error: 'Invalid JSON input', 
        statusCode: 400 
      }, 400);
    }

    const { 
      talentId, 
      jobId, 
      cvData, 
      cvFileName, 
      coverLetterData, 
      coverLetterFileName 
    } = requestData;

    log(`Processing request - Talent: ${talentId}, Job: ${jobId}`);
    log(`Files - CV: ${cvFileName || 'None'}, Cover Letter: ${coverLetterFileName || 'None'}`);
    
    // Validate required parameters
    if (!talentId || !jobId) {
      return res.json({ 
        success: false, 
        error: 'Missing required parameters: talentId and jobId are required', 
        statusCode: 400 
      }, 400);
    }

    if (!cvData && !coverLetterData) {
      return res.json({ 
        success: false, 
        error: 'At least one document (CV or cover letter) must be provided', 
        statusCode: 400 
      }, 400);
    }

    // Validate files if provided
    if (cvData && cvFileName) {
      utils.validateFile(cvFileName, cvData);
    }
    if (coverLetterData && coverLetterFileName) {
      utils.validateFile(coverLetterFileName, coverLetterData);
    }

    // Fetch required data
    log('Fetching talent, job, and employer information...');
    const [talent, job] = await Promise.all([
      dataFetcher.getTalent(talentId),
      dataFetcher.getJob(jobId)
    ]);

    let employer = null;
    if (job.employer) {
      try {
        employer = await dataFetcher.getEmployer(job.employer);
      } catch (employerError) {
        log(`Warning: Could not fetch employer: ${employerError.message}`);
      }
    }

    log(`Successfully fetched: Talent: ${talent.fullname} (${talent.careerStage}), Job: ${job.name}`);
    if (employer) log(`Employer: ${employer.name}`);

    // Process documents and perform analysis
    const results = {
      cv: null,
      coverLetter: null
    };

    // Process CV if provided
    if (cvData && cvFileName) {
      log('Processing CV...');
      try {
        const cvBuffer = Buffer.from(cvData, 'base64');
        
        // Upload temporary file for processing
        try {
          const tempCvFile = await storage.createFile(
            config.storageId,
            ID.unique(),
            cvBuffer,
            [`read("user:${talentId}")`, `delete("user:${talentId}")`]
          );
          uploadedFileIds.push(tempCvFile.$id);
          log(`CV uploaded temporarily: ${tempCvFile.$id}`);
        } catch (uploadError) {
          log(`Warning: Could not upload CV to storage: ${uploadError.message}`);
        }

        // Extract text from CV
        const cvText = await documentProcessor.extractText(cvBuffer, cvFileName, 'CV');
        log(`CV text extracted: ${cvText.length} characters`);

        // Analyze CV with career stage consideration
        results.cv = await aiAnalyzer.analyzeCVForJob(cvText, talent, job, employer);
        log('CV analysis completed successfully');

      } catch (cvError) {
        error(`CV processing failed: ${cvError.message}`);
        throw cvError; // Don't provide fallback analysis as requested
      }
    }

    // Process Cover Letter if provided
    if (coverLetterData && coverLetterFileName) {
      log('Processing Cover Letter...');
      try {
        const coverLetterBuffer = Buffer.from(coverLetterData, 'base64');
        
        // Upload temporary file for processing
        try {
          const tempCoverLetterFile = await storage.createFile(
            config.storageId,
            ID.unique(),
            coverLetterBuffer,
            [`read("user:${talentId}")`, `delete("user:${talentId}")`]
          );
          uploadedFileIds.push(tempCoverLetterFile.$id);
          log(`Cover letter uploaded temporarily: ${tempCoverLetterFile.$id}`);
        } catch (uploadError) {
          log(`Warning: Could not upload cover letter to storage: ${uploadError.message}`);
        }

        // Extract text from cover letter
        const coverLetterText = await documentProcessor.extractText(
          coverLetterBuffer, 
          coverLetterFileName, 
          'Cover Letter'
        );
        log(`Cover letter text extracted: ${coverLetterText.length} characters`);

        // Analyze cover letter with career stage consideration
        results.coverLetter = await aiAnalyzer.analyzeCoverLetterForJob(
          coverLetterText, 
          talent, 
          job, 
          employer
        );
        log('Cover letter analysis completed successfully');

      } catch (coverLetterError) {
        error(`Cover letter processing failed: ${coverLetterError.message}`);
        throw coverLetterError; // Don't provide fallback analysis as requested
      }
    }

    // Generate combined insights if both documents were analyzed
    let combinedInsights = null;
    if (results.cv && results.coverLetter) {
      const careerStageContext = utils.getCareerStageContext(talent.careerStage);
      
      combinedInsights = {
        overallApplicationScore: Math.round(
          (results.cv.overallMatchScore + results.coverLetter.overallEffectiveness) / 2
        ),
        careerStageReadiness: {
          score: Math.round(
            ((results.cv.careerStageAlignment?.score || 50) + 
             (results.coverLetter.careerStageAppropriate?.score || 50)) / 2
          ),
          alignment: `Strong alignment for ${talent.careerStage} career stage`,
          recommendation: results.cv.overallMatchScore >= 70 && results.coverLetter.overallEffectiveness >= 70 
            ? "Application ready - good fit for career stage"
            : "Consider improvements before submission"
        },
        consistencyCheck: {
          score: 75,
          strengthsAlignment: "Documents consistently highlight relevant experience",
          improvementAreas: "Ensure skill emphasis matches between documents"
        },
        strategicAdvice: [
          `Focus on ${careerStageContext.focus.toLowerCase()} in your application approach`,
          "Align both documents to emphasize your career stage strengths",
          "Highlight growth potential and learning mindset"
        ]
      };
    }

    // Prepare streamlined response
    const executionTime = Date.now() - startTime;
    const careerStageContext = utils.getCareerStageContext(talent.careerStage);
    
    const response = {
      success: true,
      statusCode: 200,
      analysis: {
        cv: results.cv,
        coverLetter: results.coverLetter,
        combinedInsights: combinedInsights
      },
      careerStageContext: {
        stage: talent.careerStage,
        description: careerStageContext.description,
        focus: careerStageContext.focus,
        priorities: careerStageContext.priorities
      },
      jobContext: {
        position: job.name,
        company: employer?.name || 'Company information not available',
        level: job.seniorityLevel,
        industry: job.industry
      },
      summary: {
        documentsAnalyzed: {
          cv: !!results.cv,
          coverLetter: !!results.coverLetter
        },
        executionTime: executionTime,
        analyzedAt: new Date().toISOString()
      }
    };

    log(`=== Analysis Completed Successfully ===`);
    log(`Career Stage: ${talent.careerStage}`);
    log(`Execution time: ${executionTime}ms`);
    log(`Documents processed: CV: ${!!results.cv}, Cover Letter: ${!!results.coverLetter}`);
    
    return res.json(response);

  } catch (unexpectedError) {
    const executionTime = Date.now() - startTime;
    error(`Unexpected error in document analysis: ${unexpectedError.message}`);

    return res.json({
      success: false,
      error: 'Analysis failed: ' + unexpectedError.message,
      statusCode: 500,
      executionTime: executionTime
    }, 500);

  } finally {
    // Clean up temporary files
    if (uploadedFileIds.length > 0) {
      log(`Cleaning up ${uploadedFileIds.length} temporary files...`);
      const cleanupPromises = uploadedFileIds.map(async (fileId) => {
        try {
          await storage.deleteFile(config.storageId, fileId);
          log(`Cleaned up temporary file: ${fileId}`);
        } catch (deleteError) {
          error(`Failed to cleanup temporary file ${fileId}: ${deleteError.message}`);
        }
      });
      
      await Promise.allSettled(cleanupPromises);
    }
  }
};